package com.keepaccounts.app;

import android.webkit.JavascriptInterface;

/**
 * Plain "app control" bridge, registered under the JavaScript names {@code NativeApp}
 * (and the alias {@code AndroidBridge}).
 *
 * <pre>
 *   NativeApp.available()             -> true
 *   NativeApp.getServerUrl()          -> "" when local (file://) mode is active
 *   NativeApp.setServerUrl(url)       -> persists to SharedPreferences "server_url" and reloads
 *   NativeApp.reload()                -> reloads the configured start URL
 *   NativeApp.appVersion()            -> "1.0"
 *   NativeApp.getAppVersion()         -> alias of appVersion()
 *   NativeApp.openInBrowser(url)      -> hands the url to the system browser
 *   NativeApp.toast(message)          -> short toast on the UI thread
 * </pre>
 *
 * <p>Every method here is invoked on the WebView's private JavaBridge thread, never on the UI
 * thread, so all UI work is funnelled through {@link MainActivity}.
 *
 * <p>An empty {@code setServerUrl("")} switches back to the bundled {@code file://} UI.
 */
public final class AppBridge {

    private final MainActivity activity;

    public AppBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean available() {
        return true;
    }

    @JavascriptInterface
    public String getServerUrl() {
        return activity.serverUrl();
    }

    @JavascriptInterface
    public void setServerUrl(String url) {
        activity.saveServerUrl(url);
        activity.reloadApp();
    }

    @JavascriptInterface
    public void reload() {
        activity.reloadApp();
    }

    @JavascriptInterface
    public String appVersion() {
        return activity.versionName();
    }

    @JavascriptInterface
    public String getAppVersion() {
        return activity.versionName();
    }

    @JavascriptInterface
    public void openInBrowser(String url) {
        activity.openExternal(url);
    }

    @JavascriptInterface
    public void toast(String message) {
        activity.showToast(message);
    }
}
