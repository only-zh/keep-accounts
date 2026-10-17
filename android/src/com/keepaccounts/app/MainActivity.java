package com.keepaccounts.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.provider.Settings;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URL;
import java.util.Locale;

/**
 * Hand-rolled WebView shell for the Keep Accounts web app.
 *
 * <p>No AndroidX, no support library, no Gradle. The whole APK is produced by
 * {@code build.sh} using aapt2 + javac + d8 + zipalign + apksigner.
 *
 * <p>Two JavaScript bridges are exposed:
 * <ul>
 *   <li>{@code NativeHttp} - {@link NativeHttp}, the CORS bypass for third-party APIs.</li>
 *   <li>{@code NativeApp} / {@code AndroidBridge} - {@link AppBridge}, server-url + reload.</li>
 * </ul>
 */
public class MainActivity extends Activity {

    private static final String TAG = "KeepAccounts";

    /** Bundled UI, staged by build.sh from {@code public/} and {@code shared/}. */
    /**
     * 内置资源通过 HTTPS 假域名提供（由 shouldInterceptRequest 拦截，不会真的走网络）。
     * 用 https 而不是 file:// 的原因：file:// 不是安全上下文，
     * WebView 在那种页面里没有 getUserMedia，摄像头和麦克风都用不了。
     */
    private static final String ASSET_ORIGIN = "https://appassets.local";
    private static final String LOCAL_URL = ASSET_ORIGIN + "/index.html";
    private static final String ASSET_BASE_URL = "file:///android_asset/ui/";

    private static final String PREFS = "keep_accounts";
    private static final String KEY_SERVER_URL = "server_url";

    private static final int REQ_RECORD_AUDIO = 1001;
    private static final int REQ_CAMERA = 1002;

    private static final String UA_SUFFIX = " KeepAccountsApp/1.0";

    /** #0F1115 - keep in sync with res/values/colors.xml. */
    private static final int BG_COLOR = 0xFF0F1115;

    /** Give up recreating after this many renderer crashes, to avoid a restart loop. */
    private static final int MAX_RENDERER_RESTARTS = 2;

    private static int sRendererRestarts = 0;

    private WebView webView;
    private long updateDownloadId = -1;
    private DownloadReceiver downloadReceiver;
    private FrameLayout root;
    private NativeHttp nativeHttp;
    private PermissionRequest pendingPermissionRequest;

    private final Handler handler = new Handler(Looper.getMainLooper());

    // 注意：这里刻意用 lambda 而不是匿名内部类。
    // 字段初始化器里的匿名类会生成 EnclosingMethod 方法名为 null 的 class 文件，
    // 而 build-tools 34 自带的 R8/D8 8.2.2 在这种 class 上会抛 NPE（Cannot invoke String.length()）。
    private final Runnable reloadRunnable = this::loadStartUrl;

    private volatile boolean destroyed = false;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "onCreate, version=" + versionName());

        Window window = getWindow();
        window.setStatusBarColor(BG_COLOR);
        window.setNavigationBarColor(BG_COLOR);
        clearLightSystemBarFlags(window);

        root = new FrameLayout(this);
        root.setBackgroundColor(BG_COLOR);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Status-bar inset only, and only when the platform actually hands it to us
        // (i.e. on Android 15 where targetSdk 35 forces edge-to-edge). The bottom inset is
        // intentionally left alone: the web app handles it with CSS safe-area insets.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
                int top = insets.getSystemWindowInsetTop();
                if (v.getPaddingTop() != top) {
                    v.setPadding(v.getPaddingLeft(), top, v.getPaddingRight(), v.getPaddingBottom());
                }
                return insets;
            }
);

        webView = new WebView(this);
        webView.setBackgroundColor(BG_COLOR);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        configureWebView(webView);
        root.addView(webView);

        setContentView(root);
        root.requestApplyInsets();

        try {
            WebView.setWebContentsDebuggingEnabled(true);
        } catch (Throwable t) {
            Log.w(TAG, "could not enable WebView debugging", t);
        }

        nativeHttp = new NativeHttp((id, resultJson) -> {
                dispatchNativeHttpResult(id, resultJson);
            }
);
        webView.addJavascriptInterface(nativeHttp, "NativeHttp");

        AppBridge bridge = new AppBridge(this);
        webView.addJavascriptInterface(bridge, "NativeApp");
        webView.addJavascriptInterface(bridge, "AndroidBridge");

        loadStartUrl();
        requestMicPermissionIfNeeded();
    }

    @Override
    protected void onDestroy() {
        if (downloadReceiver != null) {
            try { unregisterReceiver(downloadReceiver); } catch (Throwable ignored) { /* already gone */ }
            downloadReceiver = null;
        }
        destroyed = true;
        handler.removeCallbacks(reloadRunnable);

        if (nativeHttp != null) {
            nativeHttp.shutdown();
            nativeHttp = null;
        }

        if (webView != null) {
            try {
                root.removeView(webView);
                webView.removeJavascriptInterface("NativeHttp");
                webView.removeJavascriptInterface("NativeApp");
                webView.removeJavascriptInterface("AndroidBridge");
                webView.stopLoading();
                webView.setWebChromeClient(null);
                webView.setWebViewClient(new WebViewClient());
                webView.loadUrl("about:blank");
                webView.removeAllViews();
                webView.destroy();
            } catch (Throwable t) {
                Log.w(TAG, "WebView teardown failed", t);
            }
            webView = null;
        }
        super.onDestroy();
    }

    /** Physical back button: walk the WebView history first, then leave the app. */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
                return true;
            }
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ------------------------------------------------------------------ webview setup

    @SuppressWarnings("deprecation")
    private void configureWebView(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage / IndexedDB cache in the web app
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // Both are needed so the file:// page can itself load ./shared/*.js and reach out.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); // LAN http server
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setDefaultTextEncodingName("utf-8");

        String ua = s.getUserAgentString();
        if (ua == null) {
            ua = "";
        }
        if (ua.indexOf("KeepAccountsApp/") < 0) {
            s.setUserAgentString(ua + UA_SUFFIX);
        }

        view.setWebViewClient(new AppWebViewClient(this));
        view.setWebChromeClient(new AppChromeClient(this));
    }

    private void clearLightSystemBarFlags(Window window) {
        try {
            View decor = window.getDecorView();
            int flags = decor.getSystemUiVisibility();
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(flags);
        } catch (Throwable t) {
            Log.w(TAG, "could not clear light system bar flags", t);
        }
    }

    // ------------------------------------------------------------------ in-app update

    /** 下载新版本 APK，完成后弹出系统安装界面 */
    void startApkUpdate(final String url) {
        if (url == null || url.trim().length() == 0) {
            showToast("没有可用的下载地址");
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                // 需要用户允许「安装未知来源应用」
                showToast("请允许本应用安装未知来源的应用后重试");
                Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(settingsIntent);
                return;
            }
        } catch (Throwable t) {
            Log.w(TAG, "cannot check install permission", t);
        }

        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                showToast("系统下载服务不可用");
                return;
            }
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url.trim()));
            request.setTitle("记账本更新");
            request.setDescription("正在下载新版本…");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(this, android.os.Environment.DIRECTORY_DOWNLOADS,
                    "keep-accounts-update.apk");
            request.setMimeType("application/vnd.android.package-archive");
            updateDownloadId = dm.enqueue(request);

            if (downloadReceiver == null) {
                downloadReceiver = new DownloadReceiver(this);
                IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                registerReceiver(downloadReceiver, filter);
            }
            showToast("开始下载新版本…");
        } catch (Throwable t) {
            Log.e(TAG, "startApkUpdate failed", t);
            showToast("下载失败：" + t.getMessage());
        }
    }

    void onDownloadComplete(Intent intent) {
        if (intent == null) {
            return;
        }
        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
        if (id != updateDownloadId || id < 0) {
            return;
        }
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            Uri apkUri = (dm == null) ? null : dm.getUriForDownloadedFile(id);
            if (apkUri == null) {
                showToast("下载完成但找不到文件");
                return;
            }
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(apkUri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(install);
        } catch (Throwable t) {
            Log.e(TAG, "install failed", t);
            showToast("安装失败：" + t.getMessage());
        }
    }

    /** 下载完成的广播接收器（静态内部类，避免 R8 崩溃） */
    static final class DownloadReceiver extends BroadcastReceiver {
        private final MainActivity activity;

        DownloadReceiver(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
                return;
            }
            activity.onDownloadComplete(intent);
        }
    }

    // ------------------------------------------------------------------ url handling

    /** 用户覆盖过就用它；否则用打包时写进 assets/app-config.json 的地址 */
    String serverUrl() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String value = sp.getString(KEY_SERVER_URL, "");
            if (value != null && value.trim().length() > 0) {
                return value.trim();
            }
        } catch (Throwable t) {
            Log.w(TAG, "could not read server_url", t);
        }
        return bakedStartUrl();
    }

    /**
     * 读取 build.sh 注入的接口地址与版本号。
     */
    private String bakedStartUrl() {
        try (java.io.InputStream in = getAssets().open("app-config.json")) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[2048];
            int n;
            while ((n = in.read(chunk)) > 0) {
                buf.write(chunk, 0, n);
            }
            String json = buf.toString("UTF-8");
            String value = new JSONObject(json).optString("apiBase", "");
            return value == null ? "" : value.trim();
        } catch (Throwable t) {
            Log.i(TAG, "no baked app-config.json (dev build?)");
            return "";
        }
    }

    void saveServerUrl(String url) {
        String value = url == null ? "" : url.trim();
        if (value.length() > 0 && value.indexOf("://") < 0) {
            value = "http://" + value;   // tolerate "192.168.1.5:8080"
        }
        try {
            getSharedPreferences(PREFS, MODE_PRIVATE)
                    .edit().putString(KEY_SERVER_URL, value).apply();
            Log.i(TAG, "server_url saved: " + value);
        } catch (Throwable t) {
            Log.e(TAG, "could not save server_url", t);
        }
    }

    private String resolveStartUrl() {
        // 页面永远用内置资源（不依赖网络、不读远端 UI），接口地址单独由 config.js 决定
        return LOCAL_URL;
    }

    void loadStartUrl() {
        if (destroyed || webView == null) {
            return;
        }
        String url = resolveStartUrl();
        Log.i(TAG, "loadUrl " + url);
        try {
            webView.loadUrl(url);
        } catch (Throwable t) {
            Log.e(TAG, "loadUrl failed", t);
        }
    }

    /** Coalesces a burst of setServerUrl()/reload() calls into a single page load. */
    void reloadApp() {
        if (destroyed) {
            return;
        }
        handler.removeCallbacks(reloadRunnable);
        handler.postDelayed(reloadRunnable, 120);
    }

    String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Throwable t) {
            return "1.0";
        }
    }

    void showToast(final String message) {
        if (message == null) {
            return;
        }
        runOnUiThread(() -> {
                try {
                    Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show();
                } catch (Throwable ignored) {
                    // activity may be gone
                }
            }
);
    }

    void openExternal(String url) {
        if (url == null || url.length() == 0) {
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Throwable t) {
            Log.w(TAG, "no handler for " + url, t);
            showToast("无法打开链接：" + url);
        }
    }

    private boolean isConfiguredServer(String url) {
        String urlHost = hostOf(url);
        if (urlHost == null) {
            return false;
        }
        if ("appassets.local".equalsIgnoreCase(urlHost)) {
            return true;   // 内置页面
        }
        String serverHost = hostOf(serverUrl());
        return serverHost != null && serverHost.equalsIgnoreCase(urlHost);
    }

    private static String hostOf(String url) {
        try {
            return new URL(url).getHost();
        } catch (Throwable t) {
            return null;
        }
    }

    private static boolean isLocalScheme(String lower) {
        return lower.startsWith("file://")
                || lower.startsWith("about:")
                || lower.startsWith("data:")
                || lower.startsWith("blob:")
                || lower.startsWith("javascript:")
                || lower.startsWith("content:");
    }

    private static boolean isExternalScheme(String lower) {
        return lower.startsWith("mailto:")
                || lower.startsWith("tel:")
                || lower.startsWith("sms:")
                || lower.startsWith("intent:")
                || lower.startsWith("market:")
                || lower.startsWith("geo:")
                || lower.startsWith("weixin:")
                || lower.startsWith("alipays:");
    }

    /** @return true when the WebView must NOT handle the navigation itself. */
    private boolean handleNavigation(String url) {
        if (url == null || url.length() == 0) {
            return false;
        }
        String lower = url.toLowerCase(Locale.US);
        if (isLocalScheme(lower)) {
            return false;                                  // bundled UI and inline pages
        }
        if (lower.startsWith("http://") || lower.startsWith("https://")) {
            if (isConfiguredServer(url)) {
                return false;                              // stay in the WebView
            }
            openExternal(url);                             // third-party link -> system browser
            return true;
        }
        if (isExternalScheme(lower)) {
            openExternal(url);
            return true;
        }
        Log.w(TAG, "blocked navigation to unsupported scheme: " + url);
        return true;
    }

    // ------------------------------------------------------------------ NativeHttp result

    private void dispatchNativeHttpResult(final String id, final String resultJson) {
        if (destroyed) {
            return;
        }
        final String safeId = (id == null) ? "" : id;
        runOnUiThread(() -> {
                if (destroyed || webView == null) {
                    return;
                }
                String js;
                try {
                    js = "window.__nativeHttp&&window.__nativeHttp("
                            + JSONObject.quote(safeId) + "," + JSONObject.quote(resultJson) + ")";
                } catch (Throwable t) {
                    Log.e(TAG, "could not build bridge callback", t);
                    return;
                }
                try {
                    webView.evaluateJavascript(js, null);
                } catch (Throwable t) {
                    Log.e(TAG, "evaluateJavascript failed", t);
                }
            }
);
    }

    // ------------------------------------------------------------------ microphone

    private void requestMicPermissionIfNeeded() {
        try {
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(
                        new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
            }
        } catch (Throwable t) {
            Log.w(TAG, "could not request RECORD_AUDIO", t);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_RECORD_AUDIO && requestCode != REQ_CAMERA) {
            return;
        }
        boolean granted = grantResults != null && grantResults.length > 0;
        for (int i = 0; i < (grantResults == null ? 0 : grantResults.length); i++) {
            if (grantResults[i] != PackageManager.PERMISSION_GRANTED) {
                granted = false;
            }
        }

        PermissionRequest pending = pendingPermissionRequest;
        pendingPermissionRequest = null;

        if (pending == null) {
            // 启动时预申请麦克风，这里只记日志
            if (granted) {
                Log.i(TAG, "media permission granted at startup");
            } else {
                Log.w(TAG, "media permission denied at startup");
                showToast("未授予麦克风权限，语音记账将不可用");
            }
            return;
        }
        try {
            if (granted) {
                pending.grant(pending.getResources());
            } else {
                pending.deny();
                showToast("没有拿到麦克风/相机权限，该功能不可用");
            }
        } catch (Throwable t) {
            Log.e(TAG, "could not resolve pending permission request", t);
        }
    }

    /** 授权确认弹窗：按请求的资源（麦克风/相机）给不同文案 */
    private void askUserForMedia(final PermissionRequest request, final boolean wantsAudio, final boolean wantsVideo) {
        int title = R.string.media_permission_title;
        int message = R.string.media_permission_message;
        if (wantsVideo && !wantsAudio) {
            title = R.string.camera_permission_title;
            message = R.string.camera_permission_message;
        } else if (wantsAudio && !wantsVideo) {
            title = R.string.mic_permission_title;
            message = R.string.mic_permission_message;
        }
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle(title);
        builder.setMessage(message);
        builder.setCancelable(false);
        builder.setPositiveButton(R.string.allow, (dialog, which) -> {
                try {
                    request.grant(request.getResources());
                } catch (Throwable t) {
                    Log.e(TAG, "grant failed", t);
                }
            }
);
        builder.setNegativeButton(R.string.deny, (dialog, which) -> {
                try {
                    request.deny();
                } catch (Throwable ignored) {
                    // best effort
                }
            }
);
        builder.show();
    }

    // ------------------------------------------------------------------ error page

    private void showErrorPage(final WebView view) {
        if (view == null) {
            return;
        }
        view.post(() -> {
                try {
                    view.loadDataWithBaseURL(ASSET_BASE_URL, ERROR_HTML, "text/html", "utf-8", null);
                } catch (Throwable t) {
                    Log.e(TAG, "could not show error page", t);
                }
            }
);
    }

    private static final String ERROR_HTML =
            "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
          + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
          + "<title>无法连接</title><style>"
          + "html,body{margin:0;height:100%;background:#0F1115;color:#E6E9EF;"
          + "-webkit-text-size-adjust:100%;font-family:-apple-system,BlinkMacSystemFont,"
          + "'PingFang SC','Hiragino Sans GB','Microsoft YaHei',Arial,sans-serif;}"
          + "body{display:flex;align-items:center;justify-content:center;"
          + "padding:24px 24px calc(24px + env(safe-area-inset-bottom));box-sizing:border-box;}"
          + ".card{max-width:420px;width:100%;text-align:center;}"
          + ".dot{width:56px;height:56px;border-radius:28px;margin:0 auto 20px;"
          + "background:rgba(108,140,255,.14);border:1px solid rgba(108,140,255,.5);"
          + "display:flex;align-items:center;justify-content:center;font-size:26px;"
          + "font-weight:700;color:#6C8CFF;}"
          + "h1{font-size:18px;margin:0 0 10px;font-weight:600;color:#E6E9EF;}"
          + "p{font-size:14px;line-height:1.7;color:#9AA3B2;margin:0 0 22px;}"
          + "button{-webkit-appearance:none;appearance:none;border:0;border-radius:10px;"
          + "padding:12px 22px;font-size:15px;background:#6C8CFF;color:#0B0D12;font-weight:600;}"
          + "button:active{opacity:.8}"
          + "</style></head><body><div class=\"card\">"
          + "<div class=\"dot\">!</div>"
          + "<h1>无法连接到服务器</h1>"
          + "<p>无法连接到服务器，请检查设置中的服务器地址。</p>"
          + "<button type=\"button\" onclick=\"retry()\">重试</button>"
          + "</div><script>"
          + "function retry(){try{if(window.NativeApp&&NativeApp.reload){NativeApp.reload();return;}}catch(e){}"
          + "try{if(window.AndroidBridge&&AndroidBridge.reload){AndroidBridge.reload();return;}}catch(e){}"
          + "try{location.reload();}catch(e){}}"
          + "</script></body></html>";

    // ------------------------------------------------------------------ clients

    // 这两个类刻意声明为 static：build-tools 34 自带的 R8/D8 8.2.2 在把「非静态内部类」
    // （带 this$0 合成字段的 class）转 dex 时会抛 NPE。改成静态嵌套类 + 显式持有 Activity
    // 引用，行为和原来完全一致，但不再触发该缺陷。
    private static final class AppChromeClient extends WebChromeClient {

        private final MainActivity activity;

        AppChromeClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            if (request == null) {
                return;
            }
            try {
                String[] resources = request.getResources();
                boolean wantsAudio = false;
                boolean wantsVideo = false;
                if (resources != null) {
                    for (int i = 0; i < resources.length; i++) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[i])) {
                            wantsAudio = true;
                        } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resources[i])) {
                            wantsVideo = true;
                        }
                    }
                }
                if (!wantsAudio && !wantsVideo) {
                    Log.w(TAG, "denying unsupported permission request");
                    request.deny();
                    return;
                }

                // 先补齐系统运行时权限，再让页面拿到资源
                java.util.ArrayList<String> missing = new java.util.ArrayList<>();
                if (wantsAudio && activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED) {
                    missing.add(android.Manifest.permission.RECORD_AUDIO);
                }
                if (wantsVideo && activity.checkSelfPermission(android.Manifest.permission.CAMERA)
                        != PackageManager.PERMISSION_GRANTED) {
                    missing.add(android.Manifest.permission.CAMERA);
                }
                if (!missing.isEmpty()) {
                    activity.pendingPermissionRequest = request;
                    activity.requestPermissions(missing.toArray(new String[0]),
                            wantsVideo ? REQ_CAMERA : REQ_RECORD_AUDIO);
                    return;
                }
                activity.askUserForMedia(request, wantsAudio, wantsVideo);
            } catch (Throwable t) {
                Log.e(TAG, "onPermissionRequest failed", t);
                try {
                    request.deny();
                } catch (Throwable ignored) {
                    // best effort
                }
            }
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            if (message != null) {
                Log.i(TAG, "[web] " + message.message()
                        + " @" + message.sourceId() + ":" + message.lineNumber());
            }
            return true;
        }
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.US);
        if (p.endsWith(".html") || p.endsWith("/")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private static final class AppWebViewClient extends WebViewClient {

        private final MainActivity activity;

        AppWebViewClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request == null) {
                return false;
            }
            Uri uri = request.getUrl();
            String url = (uri == null) ? null : uri.toString();

            if (!request.isForMainFrame()) {
                // Inside an iframe only keep non-web schemes away from the loader.
                if (url == null) {
                    return false;
                }
                String lower = url.toLowerCase(Locale.US);
                if (lower.startsWith("http://") || lower.startsWith("https://")
                        || isLocalScheme(lower)) {
                    return false;
                }
                return true;
            }
            return activity.handleNavigation(url);
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return activity.handleNavigation(url);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (request == null) {
                return null;
            }
            Uri uri = request.getUrl();
            if (uri == null || !"appassets.local".equalsIgnoreCase(uri.getHost())) {
                return null;   // 其它域名走正常网络
            }
            String path = uri.getPath();
            if (path == null || path.length() == 0 || "/".equals(path)) {
                path = "/index.html";
            }
            String assetPath = "ui" + path;
            try {
                InputStream in = activity.getAssets().open(assetPath);
                return new WebResourceResponse(mimeOf(assetPath), "utf-8", in);
            } catch (Throwable t) {
                Log.w(TAG, "asset missing: " + assetPath);
                return new WebResourceResponse("text/plain", "utf-8",
                        new ByteArrayInputStream("Not found".getBytes()));
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request == null || !request.isForMainFrame()) {
                return;   // ignore sub-resource failures
            }
            CharSequence description = (error == null) ? "" : error.getDescription();
            Log.e(TAG, "main frame load failed: " + description);
            activity.showErrorPage(view);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            boolean crashed = detail != null && detail.didCrash();
            Log.e(TAG, "onRenderProcessGone, didCrash=" + crashed);
            // Returning true keeps the process alive; Android would otherwise kill the app.
            if (sRendererRestarts >= MAX_RENDERER_RESTARTS) {
                activity.showToast("页面渲染进程异常，请重新启动应用");
                return true;
            }
            sRendererRestarts++;
            if (activity.webView != null) {
                try {
                    activity.root.removeView(activity.webView);
                    activity.webView.destroy();
                } catch (Throwable ignored) {
                    // best effort
                }
                activity.webView = null;
            }
            activity.handler.post(() -> {
                    try {
                        activity.recreate();
                    } catch (Throwable t) {
                        Log.e(TAG, "could not recreate activity", t);
                    }
                }
);
            return true;
        }
    }
}
