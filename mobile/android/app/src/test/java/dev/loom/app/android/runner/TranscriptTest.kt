package dev.loom.app.android.runner

import dev.loom.app.android.core.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptTest {
    private fun ev(json: String): Any? = Json.parse(json)
    private fun delta(text: String, turn: String = "t1") = ev("""{"type":"text.delta","turnId":"$turn","text":"$text"}""")
    private fun done(text: String, turn: String = "t1") = ev("""{"type":"text.done","turnId":"$turn","text":"$text"}""")
    private fun texts(t: Transcript) = t.items.filterIsInstance<TranscriptItem.Assistant>().map { it.text }

    @Test
    fun outOfOrderPushesWaitForTheGapAndApplyOnce() {
        val t = Transcript("s")
        t.accept(1, delta("a"))
        t.accept(3, delta("c"))
        assertEquals(1L, t.cursor)
        assertTrue(t.hasGap)
        assertEquals(listOf("a"), texts(t))
        t.accept(2, delta("b"))
        assertEquals(3L, t.cursor)
        assertFalse(t.hasGap)
        assertEquals(listOf("abc"), texts(t))
        // Duplicates of applied or buffered events are ignored.
        t.accept(2, delta("b"))
        t.accept(3, delta("c"))
        assertEquals(listOf("abc"), texts(t))
    }

    @Test
    fun replayOverlappingLivePushesAppliesEachEventOnce() {
        val t = Transcript("s")
        // Live pushes arrive while the replay request is in flight.
        t.accept(4, delta("d"))
        t.accept(5, delta("e"))
        assertEquals(0L, t.cursor)
        val replay = Json.parse(
            """[{"seq":1,"event":{"type":"user.text","turnId":"t1","text":"hi"}},
                {"seq":2,"event":{"type":"turn.started","turnId":"t1","at":1}},
                {"seq":3,"event":{"type":"text.delta","turnId":"t1","text":"abc"}},
                {"seq":4,"event":{"type":"text.delta","turnId":"t1","text":"d"}}]"""
        )
        t.acceptReplay(replay)
        assertEquals(5L, t.cursor)
        assertEquals(listOf("abcde"), texts(t))
        assertEquals("hi", (t.items.first() as TranscriptItem.User).text)
        // A reconnect replay from cursor 0 again changes nothing.
        t.acceptReplay(replay)
        assertEquals(listOf("abcde"), texts(t))
    }

    @Test
    fun invalidSequenceNumbersAreIgnored() {
        val t = Transcript("s")
        t.accept(0, delta("x"))
        t.accept(-3, delta("x"))
        t.acceptReplay(Json.parse("""[{"seq":1.5,"event":{"type":"text.delta","turnId":"t","text":"x"}}, "junk", null]"""))
        assertEquals(0L, t.cursor)
        assertTrue(t.items.isEmpty())
    }

    @Test
    fun finalTextReplacesStreamedTextInsteadOfAppending() {
        val t = Transcript("s")
        t.accept(1, delta("Hel"))
        t.accept(2, delta("lo wor"))
        t.accept(3, done("Hello world."))
        val items = t.items.filterIsInstance<TranscriptItem.Assistant>()
        assertEquals(1, items.size)
        assertEquals("Hello world.", items[0].text)
        assertTrue(items[0].final)
    }

    @Test
    fun doneWithoutDeltasAddsOneSegment() {
        val t = Transcript("s")
        t.accept(1, done("Only final"))
        assertEquals(listOf("Only final"), texts(t))
    }

    @Test
    fun toolsSeparateTextSegmentsWithinOneTurn() {
        val t = Transcript("s")
        t.accept(1, delta("Looking"))
        t.accept(2, done("Looking at files."))
        t.accept(3, ev("""{"type":"tool.call","turnId":"t1","callId":"c1","name":"bash","args":{"command":"ls -la"}}"""))
        t.accept(4, ev("""{"type":"tool.result","turnId":"t1","callId":"c1","ok":true,"output":"a\nb"}"""))
        t.accept(5, delta("Found"))
        t.accept(6, delta(" two"))
        t.accept(7, done("Found two files."))
        assertEquals(listOf("Looking at files.", "Found two files."), texts(t))
        val tool = t.items.filterIsInstance<TranscriptItem.Tool>().single()
        assertEquals("bash", tool.name)
        assertEquals("ls -la", tool.summary)
        assertEquals(true, tool.ok)
        assertEquals("a\nb", tool.output)
        assertEquals(listOf("Assistant", "Tool", "Assistant"), t.items.map { it::class.simpleName })
    }

    @Test
    fun turnEndFinalizesStreamAndRecordsInterruption() {
        val t = Transcript("s")
        t.accept(1, ev("""{"type":"turn.started","turnId":"t1","at":1}"""))
        assertEquals("t1", t.runningTurn)
        t.accept(2, delta("partial"))
        t.accept(3, ev("""{"type":"turn.done","turnId":"t1","stopReason":"cancelled"}"""))
        assertNull(t.runningTurn)
        assertTrue(t.items.filterIsInstance<TranscriptItem.Assistant>().single().final)
        assertEquals("cancelled", t.items.filterIsInstance<TranscriptItem.TurnEnd>().single().stopReason)
        // A later delta in a new turn starts a fresh segment.
        t.accept(4, delta("next", "t2"))
        assertEquals(listOf("partial", "next"), texts(t))
    }

    private val questionJson = """{"type":"question.requested","requestId":"r1","turnId":"t1","blocking":true,
        "questions":[
          {"id":"pick","header":"Choice","question":"Which?","options":[{"label":"A","description":"first"},{"label":"B","description":""}],"isOther":true,"multiSelect":false},
          {"id":"many","header":"","question":"Which ones?","options":[{"label":"X","description":""},{"label":"Y","description":""}],"multiSelect":true},
          {"id":"key","header":"Token","question":"Paste the token","options":null,"isSecret":true}
        ]}"""

    @Test
    fun questionsParseAndResolveByAnswerResolutionOrTurnEnd() {
        val t = Transcript("s")
        t.accept(1, ev(questionJson))
        val q = t.items.filterIsInstance<TranscriptItem.Question>().single()
        assertEquals(QuestionStatus.Open, q.status)
        assertEquals(3, q.request.questions.size)
        assertTrue(q.request.questions[0].isOther)
        assertFalse(q.request.questions[0].multiSelect)
        assertTrue(q.request.questions[1].multiSelect)
        assertTrue(q.request.questions[2].isSecret)
        assertTrue(q.request.questions[2].options.isEmpty())
        assertEquals(listOf(q), t.openQuestions)

        t.accept(2, ev("""{"type":"question.answered","turnId":"t1","requestId":"r1","answers":{"pick":["A"],"key":["s3cret"]}}"""))
        val answered = t.items.filterIsInstance<TranscriptItem.Question>().single()
        assertEquals(QuestionStatus.Answered, answered.status)
        assertTrue(t.openQuestions.isEmpty())
        // Secret answers are never retained in transcript memory.
        assertEquals(mapOf("pick" to listOf("A")), answered.visibleAnswers)

        val t2 = Transcript("s")
        t2.accept(1, ev(questionJson))
        t2.accept(2, ev("""{"type":"question.resolved","requestId":"r1","turnId":"t1"}"""))
        assertEquals(QuestionStatus.Resolved, t2.items.filterIsInstance<TranscriptItem.Question>().single().status)

        val t3 = Transcript("s")
        t3.accept(1, ev(questionJson))
        t3.accept(2, ev("""{"type":"turn.done","turnId":"t1","stopReason":"interrupted"}"""))
        assertEquals(QuestionStatus.Closed, t3.items.filterIsInstance<TranscriptItem.Question>().single().status)
        assertTrue(t3.openQuestions.isEmpty())
    }

    @Test
    fun answersFollowSingleMultiOtherAndSecretRules() {
        val t = Transcript("s")
        t.accept(1, ev(questionJson))
        val request = t.items.filterIsInstance<TranscriptItem.Question>().single().request
        val ok = QuestionAnswers.build(
            request,
            mapOf(
                "pick" to QuestionForm(selected = listOf("B")),
                "many" to QuestionForm(selected = listOf("X", "Y")),
                "key" to QuestionForm(text = "tok")
            )
        )
        assertEquals(mapOf("pick" to listOf("B"), "many" to listOf("X", "Y"), "key" to listOf("tok")), ok)
        val other = QuestionAnswers.build(
            request,
            mapOf(
                "pick" to QuestionForm(selected = listOf(QuestionForm.OTHER), text = "Custom"),
                "many" to QuestionForm(selected = listOf("Y")),
                "key" to QuestionForm(text = "tok")
            )
        )
        assertEquals(listOf("Custom"), other!!["pick"])
        // Missing secret, blank other text, two picks for single-select, unknown label: not ready.
        assertNull(QuestionAnswers.build(request, mapOf("pick" to QuestionForm(listOf("A")), "many" to QuestionForm(listOf("X")))))
        assertNull(QuestionAnswers.build(request, mapOf("pick" to QuestionForm(listOf(QuestionForm.OTHER), "  "), "many" to QuestionForm(listOf("X")), "key" to QuestionForm(text = "t"))))
        assertNull(QuestionAnswers.build(request, mapOf("pick" to QuestionForm(listOf("A", "B")), "many" to QuestionForm(listOf("X")), "key" to QuestionForm(text = "t"))))
        assertNull(QuestionAnswers.build(request, mapOf("pick" to QuestionForm(listOf("Z")), "many" to QuestionForm(listOf("X")), "key" to QuestionForm(text = "t"))))
        assertNull(QuestionAnswers.build(request, mapOf("pick" to QuestionForm(listOf("A")), "many" to QuestionForm(emptyList()), "key" to QuestionForm(text = "t"))))
    }

    @Test
    fun unknownEventTypesAdvanceTheCursorWithoutBreakingTheFold() {
        val t = Transcript("s")
        t.accept(1, ev("""{"type":"usage","turnId":"t1","inputTokens":5}"""))
        t.accept(2, ev("""{"type":"something.new","x":1}"""))
        t.accept(3, delta("ok"))
        assertEquals(3L, t.cursor)
        assertEquals(listOf("ok"), texts(t))
    }
}
