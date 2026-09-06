package com.zimrafdms

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509KeyManager
import javax.net.ssl.X509TrustManager

/**
 * Keystore-backed signing and mutual TLS for zimra-fdms.
 *
 * The private key is generated with PURPOSE_SIGN only and never leaves the
 * keystore. Signature("SHA256withECDSA") hashes and returns DER, which is
 * what FDMS verifies. For TLS, an X509KeyManager hands Conscrypt the key
 * handle plus the FDMS-issued certificate, so the same key is both the
 * receipt signer and the client identity.
 */
class ZimraFdmsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ZimraFdms"

    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    }

    /** One client per (alias, certificate), so TLS sessions are reused. */
    private val clients = ConcurrentHashMap<String, OkHttpClient>()

    // -- keys ---------------------------------------------------------------

    @ReactMethod
    fun generateKey(alias: String, requireStrongBox: Boolean, promise: Promise) {
        try {
            val strongBox = generate(alias, requireStrongBox)
            promise.resolve(Arguments.createMap().apply { putBoolean("strongBox", strongBox) })
        } catch (e: Exception) {
            promise.reject("KEYSTORE", e.message, e)
        }
    }

    private fun generate(alias: String, requireStrongBox: Boolean): Boolean {
        val builder = { strongBox: Boolean ->
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                // DIGEST_NONE as well as SHA-256: for TLS client authentication
                // Conscrypt signs the already-hashed transcript with NONEwithECDSA.
                // Found on the emulator; without it the mTLS handshake fails.
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
                // Attestation lets a bank verify the key is hardware-backed.
                .setAttestationChallenge(alias.toByteArray())
                .apply { if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true) }
                .build()
        }
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        if (Build.VERSION.SDK_INT >= 28) {
            try {
                kpg.initialize(builder(true))
                kpg.generateKeyPair()
                return true
            } catch (e: StrongBoxUnavailableException) {
                if (requireStrongBox) throw e
            }
        } else if (requireStrongBox) {
            throw IllegalStateException("StrongBox needs Android 9 or later")
        }
        kpg.initialize(builder(false))
        kpg.generateKeyPair()
        return false
    }

    @ReactMethod
    fun hasKey(alias: String, promise: Promise) {
        try {
            promise.resolve(keyStore.containsAlias(alias))
        } catch (e: Exception) {
            promise.reject("KEYSTORE", e.message, e)
        }
    }

    @ReactMethod
    fun deleteKey(alias: String, promise: Promise) {
        try {
            keyStore.deleteEntry(alias)
            clients.keys.removeAll { it.startsWith("$alias|") }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("KEYSTORE", e.message, e)
        }
    }

    @ReactMethod
    fun sign(alias: String, dataBase64: String, promise: Promise) {
        try {
            val key = privateKey(alias)
            val sig = Signature.getInstance("SHA256withECDSA").apply {
                initSign(key)
                update(Base64.decode(dataBase64, Base64.DEFAULT))
            }
            promise.resolve(Base64.encodeToString(sig.sign(), Base64.NO_WRAP))
        } catch (e: Exception) {
            promise.reject("SIGN", e.message, e)
        }
    }

    @ReactMethod
    fun publicKeySpki(alias: String, promise: Promise) {
        try {
            // getEncoded() on a Java PublicKey is X.509 SubjectPublicKeyInfo DER.
            val pub = keyStore.getCertificate(alias)?.publicKey
                ?: throw IllegalStateException("No key with alias $alias")
            promise.resolve(Base64.encodeToString(pub.encoded, Base64.NO_WRAP))
        } catch (e: Exception) {
            promise.reject("KEYSTORE", e.message, e)
        }
    }

    @ReactMethod
    fun attestationChain(alias: String, promise: Promise) {
        try {
            val chain = keyStore.getCertificateChain(alias) ?: emptyArray()
            val out = Arguments.createArray()
            for (cert in chain) out.pushString(toPem(cert.encoded, "CERTIFICATE"))
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("KEYSTORE", e.message, e)
        }
    }

    private fun privateKey(alias: String): PrivateKey =
        (keyStore.getKey(alias, null) as? PrivateKey)
            ?: throw IllegalStateException("No key with alias $alias")

    // -- HTTP ---------------------------------------------------------------

    @ReactMethod
    fun request(alias: String?, certificatePem: String?, req: ReadableMap, promise: Promise) {
        try {
            val client = client(alias, certificatePem, req.getInt("timeoutMs"))
            val builder = Request.Builder().url(req.getString("url")!!)
            val headers = req.getMap("headers")
            if (headers != null) {
                val it = headers.keySetIterator()
                while (it.hasNextKey()) {
                    val k = it.nextKey()
                    builder.header(k, headers.getString(k) ?: "")
                }
            }
            val body = if (req.hasKey("body") && !req.isNull("body")) req.getString("body") else null
            val method = req.getString("method") ?: "GET"
            val contentType = (headers?.getString("Content-Type") ?: "application/json").toMediaType()
            builder.method(method, body?.toRequestBody(contentType))

            client.newCall(builder.build()).execute().use { res ->
                val out = Arguments.createMap()
                out.putInt("status", res.code)
                val h = Arguments.createMap()
                for (name in res.headers.names()) {
                    h.putString(name.lowercase(), res.headers.values(name).joinToString(", "))
                }
                out.putMap("headers", h)
                out.putString("text", res.body?.string() ?: "")
                promise.resolve(out)
            }
        } catch (e: IOException) {
            promise.reject("NETWORK", e.message, e)
        } catch (e: Exception) {
            promise.reject("HTTP", e.message, e)
        }
    }

    private fun client(alias: String?, certificatePem: String?, timeoutMs: Int): OkHttpClient {
        val key = "${alias ?: ""}|${certificatePem?.hashCode() ?: 0}|$timeoutMs"
        return clients.getOrPut(key) {
            val b = OkHttpClient.Builder()
                .connectTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
            if (alias != null && certificatePem != null) {
                val chain = parseChain(certificatePem)
                val km = KeystoreKeyManager(alias, privateKey(alias), chain)
                val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
                tmf.init(null as KeyStore?)
                val tm = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
                val ctx = SSLContext.getInstance("TLS")
                ctx.init(arrayOf(km), arrayOf(tm), null)
                b.sslSocketFactory(ctx.socketFactory, tm)
            }
            b.build()
        }
    }

    private fun parseChain(pem: String): Array<X509Certificate> {
        val cf = CertificateFactory.getInstance("X.509")
        return cf.generateCertificates(ByteArrayInputStream(pem.toByteArray()))
            .map { it as X509Certificate }
            .toTypedArray()
    }

    private fun toPem(der: ByteArray, label: String): String =
        "-----BEGIN $label-----\n" +
            Base64.encodeToString(der, Base64.NO_WRAP).chunked(64).joinToString("\n") +
            "\n-----END $label-----\n"

    /**
     * Presents one keystore key as the TLS client identity. The certificate
     * was issued by FDMS and is stored by the app, not in the keystore, so
     * the two are joined here rather than through KeyStore.setKeyEntry,
     * which AndroidKeyStore does not support for generated keys.
     */
    private class KeystoreKeyManager(
        private val alias: String,
        private val key: PrivateKey,
        private val chain: Array<X509Certificate>,
    ) : X509KeyManager {
        override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = alias
        override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
        override fun getCertificateChain(alias: String?) = if (alias == this.alias) chain else null
        override fun getPrivateKey(alias: String?) = if (alias == this.alias) key else null
        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(alias)
        override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
    }
}
