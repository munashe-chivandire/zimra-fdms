package com.zimrafdms.check;

import android.util.Base64;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * A very small HTTP/1.1 server. Every endpoint takes and returns one JSON
 * object; see Keystore for what they do.
 */
public class Bridge implements Runnable {
    private static final String TAG = "ZimraBridge";
    private final int port;
    private final Keystore keystore = new Keystore();

    public Bridge(int port) {
        this.port = port;
    }

    @Override
    public void run() {
        try (ServerSocket server = new ServerSocket(port)) {
            Log.i(TAG, "listening on " + port);
            while (true) {
                Socket s = server.accept();
                new Thread(() -> handle(s)).start();
            }
        } catch (Exception e) {
            Log.e(TAG, "server died", e);
        }
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            InputStream in = sock.getInputStream();
            String requestLine = readLine(in);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            String path = parts.length > 1 ? parts[1] : "/";
            int contentLength = 0;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int i = line.indexOf(':');
                if (i > 0 && line.substring(0, i).equalsIgnoreCase("Content-Length")) {
                    contentLength = Integer.parseInt(line.substring(i + 1).trim());
                }
            }
            byte[] body = new byte[contentLength];
            int off = 0;
            while (off < contentLength) {
                int n = in.read(body, off, contentLength - off);
                if (n < 0) break;
                off += n;
            }
            JSONObject req = contentLength > 0 ? new JSONObject(new String(body, StandardCharsets.UTF_8)) : new JSONObject();

            JSONObject res;
            int status = 200;
            try {
                res = route(path, req);
            } catch (Exception e) {
                Log.e(TAG, path + " failed", e);
                status = 500;
                res = new JSONObject().put("error", e.getClass().getSimpleName()).put("message", String.valueOf(e.getMessage()));
            }
            byte[] out = res.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream os = sock.getOutputStream();
            os.write(("HTTP/1.1 " + status + " OK\r\nContent-Type: application/json\r\nContent-Length: " + out.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            os.write(out);
            os.flush();
        } catch (Exception e) {
            Log.e(TAG, "request failed", e);
        }
    }

    private JSONObject route(String path, JSONObject req) throws Exception {
        switch (path) {
            case "/ping":
                return new JSONObject().put("ok", true).put("sdk", android.os.Build.VERSION.SDK_INT);
            case "/key":
                return new JSONObject().put("strongBox", keystore.ensureKey(req.getString("alias"), req.optBoolean("requireStrongBox", false)));
            case "/spki":
                return new JSONObject().put("spkiBase64", Base64.encodeToString(keystore.publicKeySpki(req.getString("alias")), Base64.NO_WRAP));
            case "/sign": {
                byte[] data = Base64.decode(req.getString("dataBase64"), Base64.DEFAULT);
                return new JSONObject().put("signatureBase64", Base64.encodeToString(keystore.sign(req.getString("alias"), data), Base64.NO_WRAP));
            }
            case "/attestation": {
                JSONArray arr = new JSONArray();
                for (String pem : keystore.attestationChain(req.getString("alias"))) arr.put(pem);
                return new JSONObject().put("chain", arr);
            }
            case "/delete":
                keystore.deleteKey(req.getString("alias"));
                return new JSONObject().put("ok", true);
            case "/request": {
                Map<String, String> headers = new HashMap<>();
                JSONObject h = req.optJSONObject("headers");
                if (h != null) {
                    for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                        String k = it.next();
                        headers.put(k, h.getString(k));
                    }
                }
                // optString() turns a JSON null into the string "null".
                Keystore.HttpResult r = keystore.request(
                        nullable(req, "alias"),
                        nullable(req, "certificatePem"),
                        nullable(req, "caPem"),
                        req.getString("method"),
                        req.getString("url"),
                        headers,
                        req.isNull("body") ? null : req.getString("body"),
                        req.optInt("timeoutMs", 30000));
                JSONObject rh = new JSONObject();
                for (Map.Entry<String, List<String>> e : r.headers.entrySet()) {
                    if (e.getKey() != null) rh.put(e.getKey().toLowerCase(), String.join(", ", e.getValue()));
                }
                return new JSONObject().put("status", r.status).put("headers", rh).put("text", r.text);
            }
            default:
                throw new IllegalArgumentException("no such endpoint " + path);
        }
    }

    private static String nullable(JSONObject o, String key) throws Exception {
        return o.has(key) && !o.isNull(key) ? o.getString(key) : null;
    }

    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
        }
        if (c < 0 && buf.size() == 0) return null;
        return buf.toString("UTF-8");
    }
}
