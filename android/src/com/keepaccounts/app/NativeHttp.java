package com.keepaccounts.app;

import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ProtocolException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.SSLException;

/**
 * CORS-bypass HTTP bridge.
 *
 * <p>The UI is loaded from {@code file:///android_asset/ui/index.html}. From a
 * {@code file://} origin the browser refuses cross-origin {@code fetch()} calls, so the web app
 * cannot talk to third-party HTTPS APIs (api.deepseek.com, ...) directly. This bridge performs
 * the request natively - where no same-origin policy applies - and hands the raw response back
 * to JavaScript.
 *
 * <h3>JS contract</h3>
 * <pre>
 *   NativeHttp.available()  -> true
 *   NativeHttp.request(id, method, url, headersJson, bodyBase64)          // async, no return
 *
 *   // exactly one of these two shapes is delivered, on the UI thread:
 *   window.__nativeHttp(id, '{"status":200,"headers":{...},"body":"&lt;base64&gt;"}')
 *   window.__nativeHttp(id, '{"error":"timeout after 120s"}')
 *
 *   // the page must define it before issuing requests:
 *   window.__nativeHttp = function (id, json) {
 *     var res = JSON.parse(json);
 *     if (res.error) { /* failed *\/ } else {
 *       var bytes = Uint8Array.from(atob(res.body), function (c) { return c.charCodeAt(0); });
 *       new Response(bytes, { status: res.status, headers: res.headers }).arrayBuffer()...
 *     }
 *   };
 * </pre>
 *
 * <ul>
 *   <li>{@code id} is opaque and echoed back verbatim; correlate it with your pending promise.</li>
 *   <li>{@code bodyBase64} is <b>base64 only</b> - {@code file://} bodies are deliberately not
 *       supported. Pass {@code null} or {@code ""} for no body.</li>
 *   <li>{@code headersJson} is a flat JSON object of string header names to values.</li>
 *   <li>{@code result headers} is an object of lower-or-original-case name to the first value;
 *       the HTTP status line is skipped (its key is {@code null}).</li>
 *   <li>Connect and read timeout are both {@value #TIMEOUT_MS} ms.</li>
 *   <li>HTTP error statuses (4xx/5xx) are <b>success</b>: {@code status} is set and the body is
 *       read from the error stream, so the page can parse API error payloads.</li>
 * </ul>
 */
public final class NativeHttp {

    private static final String TAG = "KeepAccounts/Http";

    /** Connect + read timeout, required by the app to be 120 seconds. */
    private static final int TIMEOUT_MS = 120000;

    private static final int COPY_BUFFER = 8192;

    private static final Set<String> ALLOWED_METHODS = new HashSet<String>(
            Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"));

    /** Headers the platform owns; forwarding them would corrupt the request. */
    private static final Set<String> RESERVED_HEADERS = new HashSet<String>(
            Arrays.asList("content-length", "host", "connection", "transfer-encoding"));

    /** Implemented by the activity: hops back to the UI thread and calls into the WebView. */
    public interface Callback {
        void onResult(String id, String resultJson);
    }

    private final Callback callback;

    // 用 lambda 而不是匿名 ThreadFactory：字段初始化器里的匿名类会生成
    // EnclosingMethod 方法名为 null 的 class 文件，R8/D8 8.2.2 会因此抛 NPE。
    private final AtomicInteger threadCounter = new AtomicInteger(1);

    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "native-http-" + threadCounter.getAndIncrement());
        t.setDaemon(true);
        return t;
    });

    public NativeHttp(Callback callback) {
        this.callback = callback;
    }

    /** Cheap capability probe so the page can pick the bridge over {@code fetch()}. */
    @JavascriptInterface
    public boolean available() {
        return true;
    }

    /**
     * Performs the HTTP call off the JS/UI thread. Returns immediately; the answer arrives via
     * {@code window.__nativeHttp(id, resultJson)}.
     */
    @JavascriptInterface
    public void request(final String id, final String method, final String url,
                        final String headersJson, final String bodyBase64) {
        try {
            executor.execute(() -> {
                    String resultJson = perform(method, url, headersJson, bodyBase64);
                    try {
                        callback.onResult(id, resultJson);
                    } catch (Throwable t) {
                        Log.e(TAG, "callback delivery failed", t);
                    }
                }
);
        } catch (RejectedExecutionException ree) {
            Log.w(TAG, "request rejected, bridge is shut down");
        } catch (Throwable t) {
            Log.e(TAG, "could not submit request", t);
            try {
                callback.onResult(id, error("could not schedule request: " + t));
            } catch (Throwable ignored) {
                // nothing else we can do
            }
        }
    }

    public void shutdown() {
        try {
            executor.shutdownNow();
        } catch (Throwable ignored) {
            // best effort
        }
    }

    // ------------------------------------------------------------------ internals

    private String perform(String method, String url, String headersJson, String bodyBase64) {
        HttpURLConnection conn = null;
        try {
            String m = (method == null || method.trim().length() == 0)
                    ? "GET" : method.trim().toUpperCase(Locale.US);
            if (!ALLOWED_METHODS.contains(m)) {
                return error("unsupported method: " + method);
            }
            if (url == null || url.trim().length() == 0) {
                return error("empty url");
            }
            final String target = url.trim();
            final String lower = target.toLowerCase(Locale.US);
            if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
                return error("only http/https urls are supported: " + target);
            }

            byte[] body = null;
            if (bodyBase64 != null && bodyBase64.length() > 0) {
                body = Base64.decode(bodyBase64, Base64.DEFAULT);
            }

            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setUseCaches(false);
            conn.setDoInput(true);
            applyMethod(conn, m);

            applyHeaders(conn, headersJson);

            if (body != null) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
                if (conn.getRequestProperty("Content-Type") == null) {
                    conn.setRequestProperty("Content-Type", "application/octet-stream");
                }
                OutputStream os = conn.getOutputStream();
                try {
                    os.write(body);
                    os.flush();
                } finally {
                    closeQuietly(os);
                }
            } else if ("POST".equals(m) || "PUT".equals(m) || "PATCH".equals(m)) {
                // Send an explicit empty body so servers do not wait on a chunked stream.
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(0);
                closeQuietly(conn.getOutputStream());
            }

            final int status = conn.getResponseCode();
            InputStream in = (status >= 400) ? conn.getErrorStream() : conn.getInputStream();
            byte[] responseBytes = (in == null) ? new byte[0] : readAll(in);

            JSONObject outHeaders = new JSONObject();
            Map<String, List<String>> headerFields = conn.getHeaderFields();
            if (headerFields != null) {
                for (Map.Entry<String, List<String>> entry : headerFields.entrySet()) {
                    String key = entry.getKey();
                    if (key == null) {
                        continue; // the status line ("HTTP/1.1 200 OK") has a null key
                    }
                    List<String> values = entry.getValue();
                    if (values == null || values.isEmpty()) {
                        continue;
                    }
                    outHeaders.put(key, values.get(0));
                }
            }

            JSONObject out = new JSONObject();
            out.put("status", status);
            out.put("headers", outHeaders);
            out.put("body", Base64.encodeToString(responseBytes, Base64.NO_WRAP));
            return out.toString();
        } catch (Throwable t) {
            Log.w(TAG, "request failed: " + t, t);
            return error(describe(t));
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                    // best effort
                }
            }
        }
    }

    /**
     * Android's {@link HttpURLConnection} rejects methods outside its permitted list on some
     * releases, historically including PATCH. Fall back to POST plus the conventional override
     * header so PATCH still reaches the server.
     */
    private static void applyMethod(HttpURLConnection conn, String method) throws ProtocolException {
        try {
            conn.setRequestMethod(method);
        } catch (ProtocolException rejected) {
            Log.w(TAG, "platform rejected " + method + ", retrying as POST + X-HTTP-Method-Override");
            conn.setRequestMethod("POST");
            conn.setRequestProperty("X-HTTP-Method-Override", method);
        }
    }

    private static void applyHeaders(HttpURLConnection conn, String headersJson) throws Exception {
        if (headersJson == null || headersJson.trim().length() == 0) {
            return;
        }
        JSONObject headers = new JSONObject(headersJson);
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (key == null || key.length() == 0) {
                continue;
            }
            if (RESERVED_HEADERS.contains(key.toLowerCase(Locale.US))) {
                continue;
            }
            Object raw = headers.opt(key);
            if (raw == null || raw == JSONObject.NULL) {
                continue;
            }
            conn.setRequestProperty(key, String.valueOf(raw));
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream(COPY_BUFFER);
            byte[] buffer = new byte[COPY_BUFFER];
            int read;
            while ((read = in.read(buffer)) != -1) {
                bos.write(buffer, 0, read);
            }
            return bos.toByteArray();
        } finally {
            closeQuietly(in);
        }
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (Throwable ignored) {
            // best effort
        }
    }

    private static String describe(Throwable t) {
        if (t instanceof SocketTimeoutException) {
            return "timeout after " + (TIMEOUT_MS / 1000) + "s";
        }
        if (t instanceof UnknownHostException) {
            return "unknown host: " + t.getMessage();
        }
        if (t instanceof SSLException) {
            return "tls error: " + t.getMessage();
        }
        String name = t.getClass().getSimpleName();
        String message = t.getMessage();
        if (message == null || message.length() == 0) {
            return name;
        }
        return name + ": " + message;
    }

    private static String error(String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("error", (message == null || message.length() == 0) ? "unknown error" : message);
            return o.toString();
        } catch (Throwable t) {
            return "{\"error\":\"unknown error\"}";
        }
    }
}
