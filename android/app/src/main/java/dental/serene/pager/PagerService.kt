package dental.serene.pager

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The station itself: what main.js does on Windows, kept alive as a foreground service so pages arrive with the
 * screen off or another app open. Owns the UDP socket, the roster, Do-Not-Disturb and the station name; the screen
 * (MainActivity's WebView, running the same ui/ as Windows) is only a view onto it.
 */
class PagerService : Service() {
    interface Listener { fun onEvent(type: String, json: String); val inForeground: Boolean }

    companion object {
        const val PORT = 41234
        const val CH_SERVICE = "service"
        const val CH_PAGES = "pages"
        const val ALERT_ID = 2
        @Volatile var instance: PagerService? = null
        @Volatile var listener: Listener? = null

        fun start(ctx: Context) {
            val i = Intent(ctx, PagerService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }

    lateinit var core: PagerCore
    private val net = Executors.newSingleThreadScheduledExecutor()
    private var socket: DatagramSocket? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    @Volatile private var running = true
    /** Pages that arrived while no screen was attached: handed over when it attaches. */
    private val undelivered = ArrayList<JSONObject>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        val prefs = getSharedPreferences("pager", MODE_PRIVATE)
        core = PagerCore(prefs.getString("name", null))
        channels()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, serviceNote(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, serviceNote())
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        // Android filters broadcast packets out while the screen is off unless an app holds a multicast lock.
        multicastLock = wifi.createMulticastLock("serene-pager").apply { setReferenceCounted(false); acquire() }
        @Suppress("DEPRECATION")
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "serene-pager").apply { setReferenceCounted(false); acquire() }
        Thread(::receiveLoop, "pager-rx").start()
        net.scheduleWithFixedDelay({ heartbeat(); if (core.prune()) emitRoster() }, 0, 3, TimeUnit.SECONDS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        running = false
        socket?.close()
        net.shutdownNow()
        multicastLock?.release(); wifiLock?.release()
        instance = null
        super.onDestroy()
    }

    // ---- network ----------------------------------------------------------------------------------------------
    private fun receiveLoop() {
        while (running) {
            try {
                val s = DatagramSocket(null).apply { reuseAddress = true; broadcast = true; bind(InetSocketAddress(PORT)) }
                socket = s
                val buf = ByteArray(65_507)
                while (running) {
                    val p = DatagramPacket(buf, buf.size)
                    s.receive(p)
                    val text = String(p.data, 0, p.length, Charsets.UTF_8)
                    val addr = p.address?.hostAddress ?: ""
                    synchronized(core) { core.onPacket(text, addr) }?.let(::dispatch)
                }
            } catch (e: Exception) {
                if (running) Thread.sleep(2000)        // network blip or Wi-Fi change: rebind
            }
        }
    }

    private fun broadcastAddresses(): List<InetAddress> {
        val out = ArrayList<InetAddress>()
        try {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.interfaceAddresses) ia.broadcast?.let { out.add(it) }
            }
        } catch (_: Exception) {}
        if (out.isEmpty()) out.add(InetAddress.getByName("255.255.255.255"))
        return out
    }

    private fun send(obj: JSONObject) {
        val s = socket ?: return
        val bytes = obj.toString().toByteArray(Charsets.UTF_8)
        for (a in broadcastAddresses()) try { s.send(DatagramPacket(bytes, bytes.size, a, PORT)) } catch (_: Exception) {}
    }

    /** UDP drops packets: send three times, like the Windows app; receivers de-duplicate by id. */
    private fun sendReliable(obj: JSONObject) {
        for (d in longArrayOf(0, 400, 900)) net.schedule({ send(obj) }, d, TimeUnit.MILLISECONDS)
    }

    private fun heartbeat() { synchronized(core) { core.hello() }?.let(::send) }

    // ---- events to the screen ---------------------------------------------------------------------------------
    private fun emitRoster() { listener?.onEvent("roster", synchronized(core) { core.rosterJson() }.toString()) }

    private fun dispatch(e: PagerCore.Event) {
        when (e) {
            is PagerCore.Event.RosterChanged -> emitRoster()
            is PagerCore.Event.Ack -> listener?.onEvent("ack", e.ack.toString())
            is PagerCore.Event.Cancelled -> {
                listener?.onEvent("cancelled", e.cancel.toString())
                synchronized(undelivered) { undelivered.removeAll { it.optString("id") == e.cancel.optString("id") } }
            }
            is PagerCore.Event.Incoming -> {
                val page = JSONObject(e.page.toString()).put("silent", e.silent)
                val l = listener
                if (l != null) l.onEvent("incoming", page.toString()) else synchronized(undelivered) { undelivered.add(page) }
                if (!e.silent && (l == null || !l.inForeground)) alert(page)
            }
        }
    }

    /** The screen attached: give it what arrived while it was gone. */
    fun drainUndelivered(): List<JSONObject> = synchronized(undelivered) { ArrayList(undelivered).also { undelivered.clear() } }

    // ---- what the screen asks for (window.pager in ui/renderer.js) --------------------------------------------
    fun state(): JSONObject = synchronized(core) {
        JSONObject().put("name", core.name ?: JSONObject.NULL).put("roster", core.rosterJson()).put("dndUntil", core.dndUntil)
    }

    fun setName(name: String): String {
        val n = name.trim().take(40)
        synchronized(core) { core.name = n }
        getSharedPreferences("pager", MODE_PRIVATE).edit().putString("name", n).apply()
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(1, serviceNote())
        net.execute(::heartbeat)
        return n
    }

    fun sendPage(payload: JSONObject): String {
        val to = payload.opt("to") ?: "ALL"
        val p = synchronized(core) { core.newPage(if (to is JSONArray || to == "ALL") to else JSONArray().put(to), payload.optString("text")) }
        sendReliable(p)
        return p.getString("id")
    }

    fun cancelPage(payload: JSONObject) = sendReliable(synchronized(core) { core.cancel(payload.optString("id"), payload.opt("to") ?: "ALL") })

    fun acknowledge(page: JSONObject) { sendReliable(synchronized(core) { core.ack(page) }); clearAlert() }

    fun setDnd(minutes: Int): Long = synchronized(core) { core.setDnd(minutes) }.also { net.execute(::heartbeat) }

    fun clearAlert() = (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(ALERT_ID)

    // ---- notifications ----------------------------------------------------------------------------------------
    private fun channels() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "Pager is on", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Keeps the station listening for pages"
        })
        nm.createNotificationChannel(NotificationChannel(CH_PAGES, "Pages", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "A page for this station"
            enableVibration(true)
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        })
    }

    private fun openApp(alert: Boolean): PendingIntent = PendingIntent.getActivity(this, if (alert) 1 else 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun serviceNote(): Notification = builder(CH_SERVICE)
        .setContentTitle("Serene Pager is on")
        .setContentText(core.name?.let { "Station: $it" } ?: "Open to name this station")
        .setOngoing(true).setContentIntent(openApp(false)).build()

    /** Screen off or the pager not in front: wake the tablet and put the page over the lock screen. */
    private fun alert(page: JSONObject) {
        val n = builder(CH_PAGES)
            .setContentTitle(page.optString("text", "Page"))
            .setContentText("From " + page.optString("from", "another station"))
            .setCategory(Notification.CATEGORY_ALARM)
            .setFullScreenIntent(openApp(true), true)
            .setContentIntent(openApp(true))
            .setAutoCancel(true)
            .build()
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(ALERT_ID, n)
        @Suppress("DEPRECATION")
        (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "serene-pager:alert")
            .acquire(10_000)
    }

    @Suppress("DEPRECATION")
    private fun builder(channel: String): Notification.Builder =
        (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channel) else Notification.Builder(this))
            .setSmallIcon(R.drawable.ic_stat_pager)
}
