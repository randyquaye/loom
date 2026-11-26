import XCTest
@testable import Loom

/// Events are decoded from the runner's own JSON, so these also cover native parsing.
private func event(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> AgentEvent {
    do {
        return try JSONDecoder().decode(AgentEvent.self, from: Data(json.utf8))
    } catch {
        XCTFail("event did not decode: \(error)", file: file, line: line)
        return .unknown
    }
}

private func replay(_ json: String) -> [SequencedEvent] {
    try! JSONDecoder().decode([SequencedEvent].self, from: Data(json.utf8))
}

private let user = event(#"{"type":"user.text","turnId":"t1","text":"Fix the build"}"#)
private let started = event(#"{"type":"turn.started","turnId":"t1","at":1800000000000}"#)
private func delta(_ text: String, turn: String = "t1") -> AgentEvent {
    event(#"{"type":"text.delta","turnId":"\#(turn)","text":"\#(text)"}"#)
}
private func done(_ text: String, turn: String = "t1") -> AgentEvent {
    event(#"{"type":"text.done","turnId":"\#(turn)","text":"\#(text)"}"#)
}
private func turnDone(_ reason: String = "end", turn: String = "t1") -> AgentEvent {
    event(#"{"type":"turn.done","turnId":"\#(turn)","stopReason":"\#(reason)"}"#)
}

private extension SessionTimeline {
    var texts: [String] {
        transcript.blocks.compactMap { if case .assistant(let text) = $0.content { return text } else { return nil } }
    }
    var kinds: [String] {
        transcript.blocks.map {
            switch $0.content {
            case .user: return "user"
            case .assistant: return "text"
            case .reasoning: return "reasoning"
            case .tool: return "tool"
            case .subagent: return "subagent"
            case .question: return "question"
            case .error: return "error"
            case .turnEnded: return "end"
            }
        }
    }
    var questions: [QuestionBlock] {
        transcript.blocks.compactMap { if case .question(let question) = $0.content { return question } else { return nil } }
    }
}

final class TimelineTests: XCTestCase {
    // MARK: Sequence recovery

    func testOverlappingReplayAndLivePushesApplyOnceInOrder() {
        var timeline = SessionTimeline()
        // Live pushes arrive while the replay request is still in flight.
        timeline.ingest(seq: 4, event: delta("c"))
        timeline.ingest(seq: 5, event: delta("d"))
        XCTAssertEqual(timeline.cursor, 0)
        XCTAssertTrue(timeline.hasGap)
        XCTAssertTrue(timeline.transcript.blocks.isEmpty, "nothing is shown out of order")

        timeline.ingest(replay: [
            SequencedEvent(seq: 1, event: user), SequencedEvent(seq: 2, event: started),
            SequencedEvent(seq: 3, event: delta("ab")), SequencedEvent(seq: 4, event: delta("c"))
        ])
        XCTAssertEqual(timeline.cursor, 5)
        XCTAssertFalse(timeline.hasGap)
        XCTAssertEqual(timeline.texts, ["abcd"])

        // The same events again, from either source, change nothing.
        timeline.ingest(seq: 5, event: delta("d"))
        timeline.ingest(replay: [SequencedEvent(seq: 3, event: delta("ab")), SequencedEvent(seq: 5, event: delta("d"))])
        XCTAssertEqual(timeline.cursor, 5)
        XCTAssertEqual(timeline.texts, ["abcd"])
    }

    func testAGapHoldsTheCursorUntilItIsFilled() {
        var timeline = SessionTimeline()
        timeline.ingest(seq: 1, event: user)
        timeline.ingest(seq: 2, event: delta("one "))
        timeline.ingest(seq: 4, event: delta("three"))
        XCTAssertEqual(timeline.cursor, 2)
        XCTAssertTrue(timeline.hasGap)
        XCTAssertEqual(timeline.texts, ["one "])

        // A replay that still lacks the missing event must not advance past it.
        timeline.ingest(replay: [SequencedEvent(seq: 4, event: delta("three"))])
        XCTAssertEqual(timeline.cursor, 2)
        XCTAssertTrue(timeline.hasGap)

        timeline.ingest(seq: 3, event: delta("two "))
        XCTAssertEqual(timeline.cursor, 4)
        XCTAssertFalse(timeline.hasGap)
        XCTAssertEqual(timeline.texts, ["one two three"])
    }

    func testUnknownAndMalformedEventsStillAdvanceTheSequence() {
        let events = replay(#"""
        [{"seq":1,"event":{"type":"user.text","turnId":"t1","text":"hi"}},
         {"seq":2,"event":{"type":"usage","turnId":"t1","inputTokens":12}},
         {"seq":3,"event":{"type":"something.new","turnId":"t1","payload":{"a":[1,2]}}},
         {"seq":4,"event":{"type":"text.delta","turnId":"t1"}},
         {"seq":5,"event":{"type":"text.done","turnId":"t1","text":"hello"}}]
        """#)
        var timeline = SessionTimeline()
        timeline.ingest(replay: events)
        XCTAssertEqual(timeline.cursor, 5)
        XCTAssertFalse(timeline.hasGap)
        XCTAssertEqual(timeline.kinds, ["user", "text"])
        XCTAssertEqual(timeline.texts, ["hello"])
    }

    // MARK: Folding

    func testFinalTextReplacesTheStreamedTextInsteadOfRepeatingIt() {
        var timeline = SessionTimeline()
        for (index, next) in [user, started, delta("Hel"), delta("lo wor"), done("Hello world.")].enumerated() {
            timeline.ingest(seq: index + 1, event: next)
        }
        XCTAssertEqual(timeline.texts, ["Hello world."])

        // A final text with no deltas before it still appears once.
        timeline.ingest(seq: 6, event: turnDone())
        timeline.ingest(seq: 7, event: event(#"{"type":"user.text","turnId":"t2","text":"again"}"#))
        timeline.ingest(seq: 8, event: done("Second answer", turn: "t2"))
        XCTAssertEqual(timeline.texts, ["Hello world.", "Second answer"])
        XCTAssertEqual(timeline.kinds, ["user", "text", "user", "text"])
    }

    func testToolsSeparateTheTextSegmentsOfOneTurn() throws {
        var timeline = SessionTimeline()
        let events = [
            user,
            delta("Looking."), done("Looking at the build."),
            event(#"{"type":"tool.call","turnId":"t1","callId":"c1","name":"bash","args":{"command":"pnpm build"}}"#),
            event(#"{"type":"tool.call","turnId":"t1","callId":"c2","name":"read_file","args":{"path":"src/a.ts"}}"#),
            event(#"{"type":"tool.result","turnId":"t1","callId":"c1","ok":false,"output":"exit 1"}"#),
            delta("Found"), done("Found it."),
            event(#"{"type":"tool.result","turnId":"t1","callId":"c2","ok":true,"output":"contents"}"#),
            turnDone()
        ]
        for (index, next) in events.enumerated() { timeline.ingest(seq: index + 1, event: next) }

        XCTAssertEqual(timeline.kinds, ["user", "text", "tool", "tool", "text"])
        XCTAssertEqual(timeline.texts, ["Looking at the build.", "Found it."], "the later final text must not overwrite the earlier segment")
        let tools = timeline.transcript.blocks.compactMap { block -> ToolCall? in
            if case .tool(let tool) = block.content { return tool } else { return nil }
        }
        XCTAssertEqual(tools.map(\.name), ["bash", "read_file"])
        XCTAssertEqual(tools.map(\.ok), [false, true])
        XCTAssertEqual(tools.map(\.output), ["exit 1", "contents"])
        XCTAssertEqual(tools[0].summary, "pnpm build")
        XCTAssertEqual(tools[1].summary, "src/a.ts")
        XCTAssertEqual(Set(timeline.transcript.blocks.map(\.id)).count, timeline.transcript.blocks.count, "block identities are unique")
    }

    func testInterruptedTurnsAndErrorsAreVisible() {
        var timeline = SessionTimeline()
        let events = [
            user, delta("Working"),
            event(#"{"type":"error","turnId":"t1","code":"provider","message":"Rate limited","retryable":true}"#),
            turnDone("cancelled")
        ]
        for (index, next) in events.enumerated() { timeline.ingest(seq: index + 1, event: next) }
        XCTAssertEqual(timeline.kinds, ["user", "text", "error", "end"])
        XCTAssertTrue(timeline.transcript.isTurnDone("t1"))
        guard case .turnEnded(let reason) = timeline.transcript.blocks.last?.content else { return XCTFail("no end marker") }
        XCTAssertEqual(reason, "cancelled")
    }

    // MARK: Questions

    private let request = event(#"""
    {"type":"question.requested","requestId":"q1","turnId":"t1","blocking":true,"questions":[
      {"id":"env","header":"Target","question":"Which environment?","options":[
        {"label":"Staging","description":"Safe"},{"label":"Production","description":"Live"}],"isOther":true,"multiSelect":true},
      {"id":"token","header":"Access","question":"Deploy token?","isSecret":true}]}
    """#)

    func testQuestionStaysOpenUntilAnsweredOrResolved() {
        var timeline = SessionTimeline()
        timeline.ingest(seq: 1, event: user)
        timeline.ingest(seq: 2, event: request)
        XCTAssertEqual(timeline.questions.count, 1)
        XCTAssertEqual(timeline.transcript.state(of: timeline.questions[0]), .open)
        XCTAssertEqual(timeline.questions[0].request.questions.map(\.isSecret), [false, true])
        XCTAssertEqual(timeline.questions[0].request.questions[0].multiSelect, true)
        XCTAssertEqual(timeline.questions[0].request.questions[1].options, [])

        timeline.ingest(seq: 3, event: event(#"{"type":"question.answered","requestId":"q1","turnId":"t1","answers":{"env":["Staging","Production"],"token":["s3cr3t-value"]}}"#))
        XCTAssertEqual(timeline.transcript.state(of: timeline.questions[0]), .answered)
        timeline.ingest(seq: 4, event: event(#"{"type":"question.resolved","requestId":"q1","turnId":"t1"}"#))
        XCTAssertEqual(timeline.transcript.state(of: timeline.questions[0]), .answered)
    }

    func testSecretAnswersNeverReachTheTranscript() {
        var timeline = SessionTimeline()
        timeline.ingest(seq: 1, event: request)
        // Even if a runner echoed the value, the transcript must not hold or show it.
        timeline.ingest(seq: 2, event: event(#"{"type":"question.answered","requestId":"q1","turnId":"t1","answers":{"env":["Staging"],"token":["s3cr3t-value"]}}"#))
        let question = timeline.questions[0]
        XCTAssertEqual(question.answers?["env"], ["Staging"])
        XCTAssertEqual(question.answers?["token"], ["Hidden"])
        XCTAssertFalse(String(describing: timeline.transcript).contains("s3cr3t-value"))
    }

    func testResolvedWithoutAnAnswerClosesTheCard() {
        var timeline = SessionTimeline()
        timeline.ingest(seq: 1, event: request)
        timeline.ingest(seq: 2, event: event(#"{"type":"question.resolved","requestId":"q1","turnId":"t1"}"#))
        XCTAssertEqual(timeline.transcript.state(of: timeline.questions[0]), .closed)
    }

    func testTurnEndClosesBlockingQuestionsAndKeepsFollowUpsOpen() {
        var timeline = SessionTimeline()
        timeline.ingest(seq: 1, event: request)
        timeline.ingest(seq: 2, event: event(#"{"type":"question.requested","requestId":"q2","turnId":"t1","blocking":false,"questions":[{"id":"next","header":"","question":"Anything else?"}]}"#))
        timeline.ingest(seq: 3, event: event(#"{"type":"question.requested","requestId":"q3","turnId":"t1","purpose":"approval","blocking":true,"questions":[{"id":"ok","header":"Approve","question":"Run rm -rf build?","options":[{"label":"Allow","description":""},{"label":"Deny","description":""}]}]}"#))
        XCTAssertEqual(timeline.questions.map { timeline.transcript.state(of: $0) }, [.open, .open, .open])

        timeline.ingest(seq: 4, event: turnDone("cancelled"))
        let states = timeline.questions.map { timeline.transcript.state(of: $0) }
        XCTAssertEqual(states[0], .closed, "an obsolete blocking question cannot be answered")
        XCTAssertEqual(states[1], .followUp)
        XCTAssertEqual(states[2], .closed, "an obsolete approval must never be resubmitted")
        XCTAssertEqual(timeline.questions[2].request.purpose, "approval")
    }

    // MARK: Answer form

    func testAnswerFormBuildsTheRunnerPayload() throws {
        guard case .questionRequested(let parsed) = request else { return XCTFail("not a question") }
        var form = QuestionForm(request: parsed)
        XCTAssertFalse(form.isReady)

        form.toggle("env", .option(1))
        form.toggle("env", .option(0))
        form.toggle("env", .option(1))
        form.toggle("env", .option(1))
        // Toggled 1, 0, 1 (off), 1 (on): answers follow the order of selection, as on the desktop.
        XCTAssertEqual(form.answers["env"], ["Staging", "Production"])
        XCTAssertFalse(form.isReady, "the secret is still empty")

        form.setText("token", "s3cr3t")
        XCTAssertTrue(form.isReady)
        XCTAssertEqual(form.answers, ["env": ["Staging", "Production"], "token": ["s3cr3t"]])

        // "Other" needs its text before the form is ready, and sends that text.
        form.toggle("env", .other)
        XCTAssertFalse(form.isReady)
        form.setText("env", "Preview")
        XCTAssertTrue(form.isReady)
        XCTAssertEqual(form.answers["env"], ["Staging", "Production", "Preview"])

        form.clear()
        XCTAssertFalse(form.isReady)
        XCTAssertEqual(form.text("token"), "")
    }

    func testOnlyNonSecretAnswersCanBeKeptBeyondTheCard() throws {
        guard case .questionRequested(let parsed) = request else { return XCTFail("not a question") }
        var form = QuestionForm(request: parsed)
        form.toggle("env", .option(1))
        form.toggle("env", .other)
        form.setText("env", "Preview")
        form.setText("token", "s3cr3t")

        let kept = form.withoutSecrets
        XCTAssertEqual(kept.answers["env"], ["Production", "Preview"])
        XCTAssertEqual(kept.text("token"), "")
        XCTAssertFalse(String(describing: kept).contains("s3cr3t"))
        XCTAssertEqual(form.secrets(over: kept), form, "the card lays its own secret back over what was kept")
        XCTAssertEqual(QuestionForm(request: parsed).secrets(over: kept), kept)
    }

    func testSingleSelectReplacesTheChoice() {
        guard case .questionRequested(let parsed) = event(#"{"type":"question.requested","requestId":"q3","turnId":"t1","blocking":true,"questions":[{"id":"ok","header":"Approve","question":"Run it?","options":[{"label":"Allow","description":""},{"label":"Deny","description":""}]}]}"#) else {
            return XCTFail("not a question")
        }
        var form = QuestionForm(request: parsed)
        form.toggle("ok", .option(0))
        form.toggle("ok", .option(1))
        XCTAssertEqual(form.answers, ["ok": ["Deny"]])
        XCTAssertTrue(form.isReady)
    }
}
