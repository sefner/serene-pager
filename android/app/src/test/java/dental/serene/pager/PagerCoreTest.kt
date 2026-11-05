package dental.serene.pager

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The packets here are exactly what the Windows app (main.js) sends, so the tablet and the PCs understand each other. */
class PagerCoreTest {
    private var clock = 1_000_000L
    private fun core(name: String = "Tablet") = PagerCore(name) { clock }

    // what main.js puts on the wire
    private fun page(id: String, from: String, to: Any, text: String = "Doctor needed") =
        JSONObject().put("type", "page").put("id", id).put("from", from).put("to", to).put("text", text).put("ts", clock).toString()

    @Test fun helloBuildsTheRosterAndIgnoresItself() {
        val c = core()
        assertTrue(c.onPacket("""{"type":"hello","name":"Op 1","dnd":false}""", "10.0.0.5") is PagerCore.Event.RosterChanged)
        assertNull("a repeat hello changes nothing", c.onPacket("""{"type":"hello","name":"Op 1","dnd":false}""", "10.0.0.5"))
        assertTrue("a snooze shows", c.onPacket("""{"type":"hello","name":"Op 1","dnd":true}""", "10.0.0.5") is PagerCore.Event.RosterChanged)
        assertNull(c.onPacket("""{"type":"hello","name":"Tablet","dnd":false}""", "10.0.0.9"))
        val r = c.rosterJson()
        assertEquals(1, r.length()); assertEquals("Op 1", r.getJSONObject(0).getString("name")); assertTrue(r.getJSONObject(0).getBoolean("dnd"))
    }

    @Test fun silentStationsDropAfterTenSeconds() {
        val c = core()
        c.onPacket("""{"type":"hello","name":"Op 1"}""", "a")
        clock += 9_000; assertFalse(c.prune())
        clock += 2_000; assertTrue(c.prune()); assertEquals(0, c.roster.size)
    }

    @Test fun pagesForMeArriveOnceWhetherSentToMeAGroupOrEveryone() {
        val c = core()
        assertTrue(c.onPacket(page("p1", "Front Desk", "Tablet"), "a") is PagerCore.Event.Incoming)
        assertNull("the 2nd and 3rd copies are dropped", c.onPacket(page("p1", "Front Desk", "Tablet"), "a"))
        assertTrue(c.onPacket(page("p2", "Op 1", JSONArray(listOf("Op 2", "Tablet"))), "a") is PagerCore.Event.Incoming)
        assertTrue(c.onPacket(page("p3", "Op 1", "ALL"), "a") is PagerCore.Event.Incoming)
        assertNull("not for me", c.onPacket(page("p4", "Op 1", "Op 2"), "a"))
        assertNull("not for me", c.onPacket(page("p5", "Op 1", JSONArray(listOf("Op 2"))), "a"))
    }

    @Test fun snoozedPagesStillArriveButSilent() {
        val c = core()
        c.setDnd(30)
        val e = c.onPacket(page("p1", "Op 1", "ALL"), "a") as PagerCore.Event.Incoming
        assertTrue(e.silent)
        clock += 31 * 60_000
        assertFalse((c.onPacket(page("p2", "Op 1", "ALL"), "a") as PagerCore.Event.Incoming).silent)
        assertEquals("capped at 4 hours", clock + 240 * 60_000L, c.setDnd(10_000))
    }

    @Test fun ownPagesAndCancelsNeverComeBack() {
        val c = core()
        val mine = c.newPage("ALL", "Room ready")
        assertNull(c.onPacket(mine.toString(), "self"))
        assertEquals(setOf("type", "id", "from", "to", "text", "ts"), mine.keys().asSequence().toSet())
        val cancel = c.cancel(mine.getString("id"), "ALL")
        assertNull(c.onPacket(cancel.toString(), "self"))
    }

    @Test fun acksReachOnlyTheSenderOnce() {
        val c = core()
        val ack = """{"type":"ack","id":"p1","from":"Op 2","to":"Tablet"}"""
        assertTrue(c.onPacket(ack, "a") is PagerCore.Event.Ack)
        assertNull(c.onPacket(ack, "a"))
        assertNull(c.onPacket("""{"type":"ack","id":"p1","from":"Op 2","to":"Op 1"}""", "a"))
    }

    @Test fun ackAndCancelAreShapedLikeTheWindowsApp() {
        val c = core()
        val incoming = JSONObject(page("p9", "Op 3", "Tablet"))
        val a = c.ack(incoming)
        assertEquals(listOf("ack", "p9", "Tablet", "Op 3"), listOf("type", "id", "from", "to").map { a.getString(it) })
        assertEquals(4, a.length())
        val other = core("Op 3")
        assertTrue(other.onPacket(c.ack(incoming).toString(), "a") is PagerCore.Event.Ack)
        val cancel = """{"type":"cancel","id":"p9","from":"Op 3","to":["Tablet"]}"""
        assertTrue(c.onPacket(cancel, "a") is PagerCore.Event.Cancelled)
        assertNull(c.onPacket(cancel, "a"))
    }

    @Test fun garbageIsIgnored() {
        val c = core()
        assertNull(c.onPacket("not json", "a"))
        assertNull(c.onPacket("""{"type":"mystery"}""", "a"))
        assertNull("no name yet = no hello", PagerCore(null).hello())
    }
}
