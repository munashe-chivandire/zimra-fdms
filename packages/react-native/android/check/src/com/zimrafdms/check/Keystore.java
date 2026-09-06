package com.zimrafdms.check;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509KeyManager;

/**
 * The keystore and mutual-TLS logic of the React Native module, in plain
 * Java so it can be built and run on an emulator without Gradle. The
 * Kotlin module (ZimraFdmsModule.kt) does the same things with OkHttp.
 */
public class Keystore {
    private final KeyStore keyStore;

    public Keystore() {
        try {
            keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Create the key if absent. Returns whether StrongBox holds it. */
    public boolean ensureKey(String alias, boolean requireStrongBox) throws Exception {
        if (keyStore.containsAlias(alias)) return false;
        KeyPairGenerator kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        if (Build.VERSION.SDK_INT >= 28) {
            try {
                kpg.initialize(spec(alias, true));
                kpg.generateKeyPair();
                return true;
            } catch (StrongBoxUnavailableException e) {
                if (requireStrongBox) throw e;
            }
        } else if (requireStrongBox) {
            throw new IllegalStateException("StrongBox needs Android 9 or later");
        }
        kpg.initialize(spec(alias, false));
        kpg.generateKeyPair();
        return false;
    }

    private KeyGenParameterSpec spec(String alias, boolean strongBox) {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                // DIGEST_NONE as well: for TLS client authentication Conscrypt
                // hands the keystore an already-hashed transcript and signs it
                // with NONEwithECDSA. Without it the handshake dies silently.
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
                .setAttestationChallenge(alias.getBytes(StandardCharsets.UTF_8));
        if (strongBox && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true);
        return b.build();
    }

    public void deleteKey(String alias) throws Exception {
        keyStore.deleteEntry(alias);
    }

    /** DER ECDSA over SHA-256 of data. Signature.sign() returns DER already. */
    public byte[] sign(String alias, byte[] data) throws Exception {
        Signature sig = Signature.getInstance("SHA256withECDSA");
        sig.initSign(privateKey(alias));
        sig.update(data);
        return sig.sign();
    }

    /** PublicKey.getEncoded() is X.509 SubjectPublicKeyInfo DER. */
    public byte[] publicKeySpki(String alias) throws Exception {
        Certificate c = keyStore.getCertificate(alias);
        if (c == null) throw new IllegalStateException("No key with alias " + alias);
        PublicKey pub = c.getPublicKey();
        return pub.getEncoded();
    }

    public List<String> attestationChain(String alias) throws Exception {
        Certificate[] chain = keyStore.getCertificateChain(alias);
        List<String> out = new ArrayList<>();
        if (chain == null) return out;
        for (Certificate c : chain) {
            out.add("-----BEGIN CERTIFICATE-----\n" + Base64.encodeToString(c.getEncoded(), Base64.DEFAULT) + "-----END CERTIFICATE-----\n");
        }
        return out;
    }

    private PrivateKey privateKey(String alias) throws Exception {
        java.security.Key k = keyStore.getKey(alias, null);
        if (!(k instanceof PrivateKey)) throw new IllegalStateException("No key with alias " + alias);
        return (PrivateKey) k;
    }

    public static class HttpResult {
        public int status;
        public Map<String, List<String>> headers;
        public String text;
    }

    /**
     * HTTPS request. With an alias and certificate the keystore key is the
     * TLS client identity; caPem, when given, is the only trusted root.
     */
    public HttpResult request(String alias, String certificatePem, String caPem, String method, String url,
                              Map<String, String> headers, String body, int timeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        if (conn instanceof HttpsURLConnection) {
            KeyManager[] km = null;
            if (alias != null && certificatePem != null) {
                X509Certificate[] chain = parseChain(certificatePem);
                km = new KeyManager[]{new KeystoreKeyManager(alias, privateKey(alias), chain)};
            }
            TrustManager[] tm = null;
            if (caPem != null) {
                KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType());
                trust.load(null);
                int i = 0;
                for (X509Certificate c : parseChain(caPem)) trust.setCertificateEntry("ca" + (i++), c);
                TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
                tmf.init(trust);
                tm = tmf.getTrustManagers();
            }
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(km, tm, null);
            ((HttpsURLConnection) conn).setSSLSocketFactory(ctx.getSocketFactory());
        }
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setRequestMethod(method);
        for (Map.Entry<String, String> e : headers.entrySet()) conn.setRequestProperty(e.getKey(), e.getValue());
        if (body != null) {
            conn.setDoOutput(true);
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(b.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(b);
            }
        }
        HttpResult r = new HttpResult();
        r.status = conn.getResponseCode();
        r.headers = conn.getHeaderFields();
        InputStream in = r.status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        r.text = in == null ? "" : readAll(in);
        conn.disconnect();
        return r;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) buf.write(b, 0, n);
        return buf.toString("UTF-8");
    }

    private static X509Certificate[] parseChain(String pem) throws Exception {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        Collection<? extends Certificate> certs = cf.generateCertificates(new ByteArrayInputStream(pem.getBytes(StandardCharsets.UTF_8)));
        List<X509Certificate> out = new ArrayList<>();
        for (Certificate c : certs) out.add((X509Certificate) c);
        return out.toArray(new X509Certificate[0]);
    }

    /** Presents the keystore key plus the FDMS-issued certificate as the client identity. */
    private static class KeystoreKeyManager implements X509KeyManager {
        private final String alias;
        private final PrivateKey key;
        private final X509Certificate[] chain;

        KeystoreKeyManager(String alias, PrivateKey key, X509Certificate[] chain) {
            this.alias = alias;
            this.key = key;
            this.chain = chain;
        }

        public String chooseClientAlias(String[] keyType, Principal[] issuers, Socket socket) { return alias; }
        public String chooseServerAlias(String keyType, Principal[] issuers, Socket socket) { return null; }
        public X509Certificate[] getCertificateChain(String a) { return alias.equals(a) ? chain : null; }
        public PrivateKey getPrivateKey(String a) { return alias.equals(a) ? key : null; }
        public String[] getClientAliases(String keyType, Principal[] issuers) { return new String[]{alias}; }
        public String[] getServerAliases(String keyType, Principal[] issuers) { return null; }
    }
}
