package dev.loom.app.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The JSON boundary every network reply, frame and signed payload passes through. */
class JsonTest {
    private fun rejects(text: String) {
        assertThrows("should refuse: ${text.take(40)}", Json.JsonException::class.java) { Json.parse(text) }
    }

    @Test
    fun integerLiteralsAreLongsAndEverythingElseNumericIsDouble() {
        val value = Json.parse("""{"a":1,"b":-7,"c":1.0,"d":1e3,"e":12345678901234567890,"f":9007199254740993}""").asObject()!!
        assertEquals(1L, value["a"])
        assertEquals(-7L, value["b"])
        assertEquals(1.0, value["c"])
        assertEquals(1000.0, value["d"])
        assertEquals(1.2345678901234567E19, value["e"])
        assertEquals(9007199254740993L, value["f"])
        // A timestamp spelled as a fraction or exponent is never mistaken for an integer.
        assertEquals(null, value.long("c"))
        assertEquals(null, value.long("d"))
    }

    @Test
    fun parsesNestedValuesInDocumentOrder() {
        val value = Json.parse(""" {"z":[true,false,null,"s"],"a":{"k":"v"},"t":"q\"\\\/\n\u00e9\ud83d\ude00"} """).asObject()!!
        assertEquals(listOf("z", "a", "t"), value.keys.toList())
        assertEquals(listOf(true, false, null, "s"), value["z"])
        assertEquals(mapOf("k" to "v"), value["a"])
        assertEquals("q\"\\/\n\u00e9\uD83D\uDE00", value["t"])
        assertEquals("top", Json.parse("\"top\""))
    }

    @Test
    fun refusesMalformedDocuments() {
        for (text in listOf(
            "", " ", "[abc]", "[01]", "[1.]", "[+1]", "[NaN]", "[Infinity]", "['a']", "[1,]", "{\"a\":1,}",
            "[1] x", "[1]]", "{a:1}", "[/*c*/1]", "[tru]", "[\"unterminated", "{\"a\"}", "[\"\\x\"]", "[1 2]",
        )) rejects(text)
    }

    @Test
    fun refusesDuplicateKeysSoNoTwoReadersCanDisagree() {
        rejects("""{"host":"a.example.com","host":"b.example.com"}""")
        rejects("""{"o":{"k":1,"k":1}}""")
    }

    @Test
    fun nestingIsBoundedWithoutExhaustingTheStack() {
        fun nested(depth: Int) = "[".repeat(depth) + "]".repeat(depth)
        assertTrue(Json.parse(nested(100)) is List<*>)
        rejects(nested(200))
        rejects(nested(100_000))
        rejects("{\"a\":".repeat(100_000) + "1" + "}".repeat(100_000))
    }

    @Test
    fun writesWhatJavaScriptStringifyWritesForSignedPayloads() {
        // '/' stays unescaped: base64 fingerprints are signed exactly as JSON.stringify emits them.
        assertEquals(
            """["loom.transport-proof.v1","h.example.com","ab/cd+ef/gh=",1700000000000,1700000900000]""",
            Json.encode(listOf("loom.transport-proof.v1", "h.example.com", "ab/cd+ef/gh=", 1700000000000L, 1700000900000L)),
        )
        assertEquals("""{"a":"q\"\\\n\t\u0001","b":[true,null,-3],"c":{}}""",
            Json.encode(linkedMapOf("a" to "q\"\\\n\t\u0001", "b" to listOf(true, null, -3L), "c" to emptyMap<String, Any?>())))
        assertEquals("\"a/b\"", Json.quote("a/b"))
    }

    @Test
    fun encodedValuesReadBackUnchanged() {
        val value = linkedMapOf<String, Any?>(
            "text" to "line\nbreak \u2028 \u00e9 \uD83D\uDE00 </script> \u0000",
            "n" to listOf(0L, Long.MAX_VALUE, Long.MIN_VALUE, 1.5, -2.25e-7),
            "nested" to mapOf("empty" to emptyList<Any?>(), "flag" to false, "none" to null),
        )
        assertEquals(value, Json.parse(Json.encode(value)))
        // Whole doubles are written as integers, as JavaScript does.
        assertEquals("[3,2.5]", Json.encode(listOf(3.0, 2.5)))
        assertThrows(IllegalArgumentException::class.java) { Json.encode(listOf(Double.NaN)) }
        assertThrows(IllegalArgumentException::class.java) { Json.encode(listOf(Any())) }
    }
}
