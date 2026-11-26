import Foundation

struct ToolCall: Equatable {
    let name: String
    let args: JSONValue
    var output: String?
    /// Nil while the tool is still running.
    var ok: Bool?

    /// The one argument worth a glance: the command, path, pattern or address a tool was given.
    var summary: String {
        for key in ["command", "path", "file_path", "pattern", "query", "url", "description", "prompt"] {
            if let value = args[key]?.text, !value.isEmpty {
                let line = value.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? value
                return line.count > 120 ? String(line.prefix(120)) + "…" : line
            }
        }
        return ""
    }
}

struct Subagent: Equatable {
    let description: String
    var toolUses: Int?
    var lastTool: String?
    /// Nil while it is still running.
    var ok: Bool?
    var report: String?
}

struct QuestionBlock: Equatable {
    let request: QuestionRequest
    var resolved = false
    /// What was answered, as the runner reported it. Secret answers are never kept: only "Hidden".
    var answers: [String: [String]]?
}

enum QuestionState: Equatable {
    /// Waiting for an answer.
    case open
    /// Its turn ended, but it was not blocking: an answer goes out as a follow-up.
    case followUp
    /// No longer waiting: resolved elsewhere, or a blocking question whose turn ended.
    case closed
    case answered
}

struct TranscriptBlock: Identifiable, Equatable {
    enum Content: Equatable {
        case user(String)
        case assistant(String)
        case reasoning(String)
        case tool(ToolCall)
        case subagent(Subagent)
        case question(QuestionBlock)
        case error(String)
        /// A turn that ended any way but normally: cancelled, error, limit or interrupted.
        case turnEnded(String)
    }

    let id: String
    let turnId: String?
    var content: Content
}

/// Folds the flat event stream into what a person reads, as the desktop's deriveBlocks does.
struct Transcript: Equatable {
    private(set) var blocks: [TranscriptBlock] = []
    private var doneTurns: Set<String> = []
    /// The text block still open for each turn. A tool or question closes it, so the next text
    /// starts a new block instead of overwriting what came before.
    private var openText: [String: Int] = [:]
    private var reasoning: [String: Int] = [:]
    private var tools: [String: Int] = [:]
    private var subagents: [String: Int] = [:]
    private var questions: [String: Int] = [:]

    func isTurnDone(_ turnId: String) -> Bool { doneTurns.contains(turnId) }

    func state(of question: QuestionBlock) -> QuestionState {
        if question.answers != nil { return .answered }
        if question.resolved { return .closed }
        if doneTurns.contains(question.request.turnId) { return question.request.blocking ? .closed : .followUp }
        return .open
    }

    /// The current state of a question by its request, for deciding whether an answer may still go out.
    func state(ofRequest requestId: String) -> QuestionState? {
        guard let index = questions[requestId], case .question(let question) = blocks[index].content else { return nil }
        return state(of: question)
    }

    @discardableResult
    private mutating func append(_ prefix: String, _ turnId: String?, _ content: TranscriptBlock.Content) -> Int {
        blocks.append(TranscriptBlock(id: "\(prefix)-\(blocks.count)", turnId: turnId, content: content))
        return blocks.count - 1
    }

    mutating func apply(_ event: AgentEvent) {
        switch event {
        case .userText(let turnId, let text):
            append("user", turnId, .user(text))
        case .userSteer(let turnId, let text):
            append("user", turnId, .user(text))
            openText[turnId] = nil
        case .textDelta(let turnId, let text):
            if let index = openText[turnId], case .assistant(let soFar) = blocks[index].content {
                blocks[index].content = .assistant(soFar + text)
            } else {
                openText[turnId] = append("text", turnId, .assistant(text))
            }
        case .textDone(let turnId, let text):
            // The final text is the whole segment: it replaces what streamed, never adds to it.
            if let index = openText[turnId] {
                blocks[index].content = .assistant(text)
            } else {
                openText[turnId] = append("text", turnId, .assistant(text))
            }
        case .reasoningDelta(let turnId, let text):
            if let index = reasoning[turnId], case .reasoning(let soFar) = blocks[index].content {
                blocks[index].content = .reasoning(soFar + text)
            } else {
                reasoning[turnId] = append("reasoning", turnId, .reasoning(text))
            }
        case .toolCall(let turnId, let callId, let name, let args):
            tools[callId] = append("tool", turnId, .tool(ToolCall(name: name, args: args)))
            openText[turnId] = nil
        case .toolResult(let callId, let ok, let output):
            guard let index = tools[callId], case .tool(var tool) = blocks[index].content else { return }
            tool.ok = ok
            tool.output = output
            blocks[index].content = .tool(tool)
        case .subagentStart(let turnId, let callId, let description):
            subagents[callId] = append("subagent", turnId, .subagent(Subagent(description: description)))
            openText[turnId] = nil
        case .subagentProgress(let callId, let toolUses, let lastTool):
            guard let index = subagents[callId], case .subagent(var subagent) = blocks[index].content else { return }
            if let toolUses { subagent.toolUses = toolUses }
            if let lastTool { subagent.lastTool = lastTool }
            blocks[index].content = .subagent(subagent)
        case .subagentEnd(let callId, let ok, let report):
            guard let index = subagents[callId], case .subagent(var subagent) = blocks[index].content else { return }
            subagent.ok = ok
            if let report { subagent.report = report }
            blocks[index].content = .subagent(subagent)
        case .questionRequested(let request):
            questions[request.requestId] = append("question", request.turnId, .question(QuestionBlock(request: request)))
            openText[request.turnId] = nil
        case .questionAnswered(let requestId, let answers):
            guard let index = questions[requestId], case .question(var question) = blocks[index].content else { return }
            // Whatever the runner echoed, a secret answer is not held here or shown anywhere.
            var shown: [String: [String]] = [:]
            for asked in question.request.questions {
                shown[asked.id] = asked.isSecret ? ["Hidden"] : (answers[asked.id] ?? [])
            }
            question.answers = shown
            blocks[index].content = .question(question)
        case .questionResolved(let requestId):
            guard let index = questions[requestId], case .question(var question) = blocks[index].content else { return }
            question.resolved = true
            blocks[index].content = .question(question)
        case .error(let turnId, let message):
            append("error", turnId, .error(message))
        case .turnDone(let turnId, let stopReason):
            doneTurns.insert(turnId)
            openText[turnId] = nil
            if stopReason != "end" { append("end", turnId, .turnEnded(stopReason)) }
        case .unknown:
            break
        }
    }
}

/// One session's events in order. Events carry a number within their session, from 1 with no
/// gaps; this applies each number exactly once and never shows anything past a gap.
struct SessionTimeline {
    /// The last number applied with nothing missing before it.
    private(set) var cursor = 0
    private(set) var transcript = Transcript()
    /// Events that arrived ahead of something still missing.
    private var held: [Int: AgentEvent] = [:]

    /// True while later events wait for earlier ones: ask the runner for what follows `cursor`.
    var hasGap: Bool { !held.isEmpty }

    mutating func ingest(seq: Int, event: AgentEvent) {
        guard seq > cursor else { return }
        guard seq == cursor + 1 else {
            // Bounded: a flood ahead of a gap is dropped and comes back in the replay.
            if held.count < 4096 { held[seq] = event }
            return
        }
        transcript.apply(event)
        cursor = seq
        held[seq] = nil
        while let next = held.removeValue(forKey: cursor + 1) {
            transcript.apply(next)
            cursor += 1
        }
    }

    mutating func ingest(replay: [SequencedEvent]) {
        for item in replay.sorted(by: { $0.seq < $1.seq }) { ingest(seq: item.seq, event: item.event) }
    }
}

/// The answers being composed for one question request. Lives only in the card that shows it.
struct QuestionForm: Equatable {
    enum Choice: Hashable {
        case option(Int)
        case other
    }

    let request: QuestionRequest
    private var selected: [String: [Choice]] = [:]
    private var texts: [String: String] = [:]

    init(request: QuestionRequest) { self.request = request }

    func isSelected(_ questionId: String, _ choice: Choice) -> Bool { selected[questionId]?.contains(choice) ?? false }
    func text(_ questionId: String) -> String { texts[questionId] ?? "" }
    mutating func setText(_ questionId: String, _ text: String) { texts[questionId] = text }

    mutating func toggle(_ questionId: String, _ choice: Choice) {
        guard let question = request.questions.first(where: { $0.id == questionId }) else { return }
        var current = selected[questionId] ?? []
        if !question.multiSelect {
            current = [choice]
        } else if let index = current.firstIndex(of: choice) {
            current.remove(at: index)
        } else {
            current.append(choice)
        }
        selected[questionId] = current
    }

    /// One list per question, in the shape `sessions:answerQuestion` takes.
    var answers: [String: [String]] {
        var result: [String: [String]] = [:]
        for question in request.questions {
            if question.options.isEmpty {
                result[question.id] = [text(question.id)]
            } else {
                result[question.id] = (selected[question.id] ?? []).map { choice in
                    switch choice {
                    case .option(let index): return question.options.indices.contains(index) ? question.options[index].label : ""
                    case .other: return text(question.id)
                    }
                }
            }
        }
        return result
    }

    var isReady: Bool {
        answers.values.allSatisfy { values in
            !values.isEmpty && values.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }
    }

    /// The same form with every secret question left blank: all that may outlive the card.
    var withoutSecrets: QuestionForm {
        var kept = self
        for question in request.questions where question.isSecret {
            kept.selected[question.id] = nil
            kept.texts[question.id] = nil
        }
        return kept
    }

    /// `kept`, with this form's answers to secret questions laid back over it.
    func secrets(over kept: QuestionForm) -> QuestionForm {
        var merged = kept
        for question in request.questions where question.isSecret {
            merged.selected[question.id] = selected[question.id]
            merged.texts[question.id] = texts[question.id]
        }
        return merged
    }

    /// Forgets everything typed or chosen, secrets included.
    mutating func clear() {
        selected = [:]
        texts = [:]
    }
}
