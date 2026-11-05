package dental.serene.pager

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The pager protocol, with no Android in it, so it can be tested on its own. It mirrors main.js packet for packet:
 * every station broadcasts JSON over UDP port 41234 — `hello` every 3 s, and `page` / `ack` / `cancel` (each sent three
 * times, de-duplicated by id on arrival). An Android tablet speaking this is just another station to the Windows ones.
 */
class PagerCore(var name: String?, private val now: () -> Long = System::currentTimeMillis) {
    data class Station(val name: String, val address: String, val last: Long, val dnd: Boolean)

    sealed class Event {
        object RosterChanged : Event()
        data class Incoming(val page: JSONObject, val silent: Boolean) : Event()
        data class Ack(val ack: JSONObject) : Event()
        data class Cancelled(val cancel: JSONObject) : Event()
    }

    val roster = LinkedHashMap<String, Station>()
    var dndUntil = 0L
    private val seenPages = Recent()
    private val seenAcks = Recent()
    private val seenCancels = Recent()

    fun isDnd() = dndUntil > now()

    /** Turn Do-Not-Disturb on for `minutes` (0 = off), capped at 4 hours like the Windows app. */
    fun setDnd(minutes: Int): Long {
        val m = minutes.coerceIn(0, 240)
        dndUntil = if (m > 0) now() + m * 60_000L else 0L
        return dndUntil
    }

    fun hello(): JSONObject? = name?.takeIf { it.isNotBlank() }?.let {
        JSONObject().put("type", "hello").put("name", it).put("dnd", isDnd())
    }

    /** `to` is "ALL" or a JSONArray of station names, as the screen sends it. */
    fun newPage(to: Any, text: String): JSONObject {
        val id = UUID.randomUUID().toString()
        seenPages.add(id)                       // never show our own page to ourselves
        return JSONObject().put("type", "page").put("id", id).put("from", name).put("to", to).put("text", text).put("ts", now())
    }

    fun cancel(id: String, to: Any): JSONObject {
        seenCancels.add(id)                     // never process our own cancel
        return JSONObject().put("type", "cancel").put("id", id).put("from", name).put("to", to)
    }

    fun ack(page: JSONObject): JSONObject =
        JSONObject().put("type", "ack").put("id", page.optString("id")).put("from", name).put("to", page.optString("from"))

    private fun forMe(to: Any?): Boolean = when (to) {
        "ALL" -> true
        is String -> to == name
        is JSONArray -> (0 until to.length()).any { to.optString(it) == name }
        else -> false
    }

    /** One datagram in; the event it causes for the screen, if any. */
    fun onPacket(text: String, address: String): Event? {
        val m = try { JSONObject(text) } catch (e: Exception) { return null }
        when (m.optString("type")) {
            "hello" -> {
                val who = m.optString("name")
                if (who.isEmpty() || who == name) return null
                val prev = roster[who]
                val dnd = m.optBoolean("dnd", false)
                roster[who] = Station(who, address, now(), dnd)
                return if (prev == null || prev.dnd != dnd) Event.RosterChanged else null
            }
            "page" -> {
                if (m.optString("from") == name) return null
                val id = m.optString("id")
                if (seenPages.contains(id) || !forMe(m.opt("to"))) return null
                seenPages.add(id)
                return Event.Incoming(m, isDnd())
            }
            "ack" -> {
                if (m.optString("to") != name) return null
                val key = m.optString("id") + "|" + m.optString("from")
                if (seenAcks.contains(key)) return null
                seenAcks.add(key)
                return Event.Ack(m)
            }
            "cancel" -> {
                if (m.optString("from") == name) return null
                val id = m.optString("id")
                if (seenCancels.contains(id) || !forMe(m.opt("to"))) return null
                seenCancels.add(id)
                return Event.Cancelled(m)
            }
        }
        return null
    }

    /** Drop stations silent for 10 s. True when the list changed. */
    fun prune(timeoutMs: Long = 10_000): Boolean {
        val t = now()
        val gone = roster.values.filter { t - it.last > timeoutMs }.map { it.name }
        gone.forEach { roster.remove(it) }
        return gone.isNotEmpty()
    }

    fun rosterJson(): JSONArray = JSONArray().apply {
        roster.values.sortedBy { it.name.lowercase() }.forEach { put(JSONObject().put("name", it.name).put("dnd", it.dnd)) }
    }

    /** A bounded set: the Windows app keeps every id forever; a tablet that runs for months shouldn't. */
    private class Recent(private val max: Int = 2000) {
        private val set = LinkedHashSet<String>()
        fun contains(k: String) = set.contains(k)
        fun add(k: String) { set.add(k); if (set.size > max) set.remove(set.first()) }
    }
}
