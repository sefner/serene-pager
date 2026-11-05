package dental.serene.pager

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * The screen: the Windows pager's own ui/ (index.html + renderer.js, unchanged) in a WebView. android-shim.js gives it
 * the `window.pager` functions Electron's preload.js gives it on Windows, backed by PagerService. Stays on and shows
 * over the lock screen, because a pager station is a screen people glance at, not an app they open.
 */
class MainActivity : Activity(), PagerService.Listener {
    private lateinit var web: WebView
    private var tts: TextToSpeech? = null
    @Volatile override var inForeground = false
    private val origin = "https://appassets.androidplatform.net"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        PagerService.start(this)
        tts = TextToSpeech(this) { }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) { js("window.__pagerSpeechDone && __pagerSpeechDone(${JSONObject.quote(id ?: "")})") }
            @Deprecated("old API") override fun onError(id: String?) { onDone(id) }
        })

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", ShimmedAssets(WebViewAssetLoader.AssetsPathHandler(this)))
            .build()
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false   // a page arrives with nobody touching the screen
        web.addJavascriptInterface(Bridge(), "PagerNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)
            override fun onPageFinished(view: WebView, url: String) { attach() }
        }
        setContentView(web)
        web.loadUrl("$origin/assets/index.html")
        askOnce()
    }

    /** Serves ui/index.html with the shim loaded before renderer.js; every other file as it is. */
    private inner class ShimmedAssets(private val inner: WebViewAssetLoader.AssetsPathHandler) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            if (path != "index.html") return inner.handle(path)
            val html = assets.open("index.html").bufferedReader().readText()
                .replace("<script src=\"voice-clips.js\"></script>", "<script src=\"android-shim.js\"></script>\n  <script src=\"voice-clips.js\"></script>")
            return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(html.toByteArray()))
        }
    }

    private fun attach() {
        PagerService.listener = this
        PagerService.instance?.drainUndelivered()?.forEach { onEvent("incoming", it.toString()) }
    }

    override fun onResume() { super.onResume(); inForeground = true; PagerService.instance?.clearAlert() }
    override fun onPause() { inForeground = false; super.onPause() }        // the WebView keeps running: no web.onPause()
    override fun onNewIntent(intent: Intent?) { super.onNewIntent(intent); attach() }

    @Deprecated("Back keeps the station running")
    override fun onBackPressed() { moveTaskToBack(true) }

    override fun onDestroy() {
        if (PagerService.listener === this) PagerService.listener = null
        tts?.shutdown()
        web.destroy()
        super.onDestroy()
    }

    override fun onEvent(type: String, json: String) =
        js("window.__pagerEmit && __pagerEmit(${JSONObject.quote(type)}, $json)")

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    /** First run: notifications, staying awake in the background, and showing over the lock screen. Asked once each. */
    private fun askOnce() {
        val prefs = getSharedPreferences("pager", MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName) && !prefs.getBoolean("askedBattery", false)) {
            prefs.edit().putBoolean("askedBattery", true).apply()
            @SuppressLint("BatteryLife")
            val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            try { startActivity(i) } catch (_: Exception) {}
        }
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent() && !prefs.getBoolean("askedFullScreen", false)) {
            prefs.edit().putBoolean("askedFullScreen", true).apply()
            try { startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName"))) } catch (_: Exception) {}
        }
    }

    /** window.PagerNative, wrapped into window.pager by android-shim.js. Runs on WebView's bridge thread. */
    inner class Bridge {
        private fun svc() = PagerService.instance
        @JavascriptInterface fun getState(): String = (svc()?.state() ?: JSONObject().put("name", JSONObject.NULL)).toString()
        @JavascriptInterface fun setName(name: String): String = svc()?.setName(name) ?: name
        @JavascriptInterface fun sendPage(payload: String): String = svc()?.sendPage(JSONObject(payload)) ?: ""
        @JavascriptInterface fun cancelPage(payload: String) { svc()?.cancelPage(JSONObject(payload)) }
        @JavascriptInterface fun acknowledge(page: String) { svc()?.acknowledge(JSONObject(page)) }
        @JavascriptInterface fun setDnd(minutes: Int): String = (svc()?.setDnd(minutes) ?: 0L).toString()
        @JavascriptInterface fun dismiss() { svc()?.clearAlert() }
        @JavascriptInterface fun raise() { }      // the screen is already up whenever it can run
        @JavascriptInterface fun speak(text: String, id: String) {
            tts?.speak(text, TextToSpeech.QUEUE_ADD, null, id)
        }
        @JavascriptInterface fun stopSpeaking() { tts?.stop() }
    }
}
