import Foundation

/// Arbitrary JSON, for tool arguments whose shape each provider invents.
enum JSONValue: Decodable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }

    var text: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// Indented text for reading, with keys in a stable order.
    func pretty(indent: String = "") -> String {
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value): return value == value.rounded() && abs(value) < 1e15 ? String(Int64(value)) : String(value)
        case .string(let value): return value
        case .array(let items):
            return items.isEmpty ? "[]" : items.map { "\(indent)- \($0.pretty(indent: indent + "  "))" }.joined(separator: "\n")
        case .object(let fields):
            return fields.isEmpty ? "{}" : fields.keys.sorted().map { key in
                let value = fields[key]!
                switch value {
                case .array(let items) where !items.isEmpty: return "\(indent)\(key):\n\(value.pretty(indent: indent + "  "))"
                case .object(let inner) where !inner.isEmpty: return "\(indent)\(key):\n\(value.pretty(indent: indent + "  "))"
                default: return "\(indent)\(key): \(value.pretty(indent: indent + "  "))"
                }
            }.joined(separator: "\n")
        }
    }
}

struct QuestionRequest: Decodable, Equatable {
    struct Option: Decodable, Equatable {
        let label: String
        let description: String
    }

    struct Question: Decodable, Equatable, Identifiable {
        let id: String
        let header: String
        let question: String
        let options: [Option]
        let isOther: Bool
        let isSecret: Bool
        let multiSelect: Bool

        private enum Keys: String, CodingKey { case id, header, question, options, isOther, isSecret, multiSelect }

        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: Keys.self)
            id = try fields.decode(String.self, forKey: .id)
            header = try fields.decode(String.self, forKey: .header)
            question = try fields.decode(String.self, forKey: .question)
            options = try fields.decodeIfPresent([Option].self, forKey: .options) ?? []
            isOther = try fields.decodeIfPresent(Bool.self, forKey: .isOther) ?? false
            isSecret = try fields.decodeIfPresent(Bool.self, forKey: .isSecret) ?? false
            multiSelect = try fields.decodeIfPresent(Bool.self, forKey: .multiSelect) ?? false
        }
    }

    let requestId: String
    let turnId: String
    /// "approval" when the agent asks permission to act.
    let purpose: String?
    /// A blocking question stops mattering when its turn ends; others stay open as follow-ups.
    let blocking: Bool
    let questions: [Question]
}

/// One normalized agent event (src/shared/events.ts). Fields this app never shows are not read.
enum AgentEvent: Decodable, Equatable {
    case questionRequested(QuestionRequest)
    case questionAnswered(requestId: String, answers: [String: [String]])
    case questionResolved(requestId: String)
    case userText(turnId: String, text: String)
    case userSteer(turnId: String, text: String)
    case textDelta(turnId: String, text: String)
    case textDone(turnId: String, text: String)
    case reasoningDelta(turnId: String, text: String)
    case toolCall(turnId: String, callId: String, name: String, args: JSONValue)
    case toolResult(callId: String, ok: Bool, output: String)
    case subagentStart(turnId: String, callId: String, description: String)
    case subagentProgress(callId: String, toolUses: Int?, lastTool: String?)
    case subagentEnd(callId: String, ok: Bool, report: String?)
    case error(turnId: String?, message: String)
    case turnDone(turnId: String, stopReason: String)
    /// Anything newer than this app, or malformed. It still occupies its sequence number.
    case unknown

    private enum Keys: String, CodingKey {
        case type, requestId, turnId, answers, text, callId, name, args, ok, output, description
        case toolUses, lastTool, report, message, stopReason
    }

    init(from decoder: Decoder) throws {
        // One event this app cannot read must never stall the ones after it.
        self = (try? Self.parse(decoder)) ?? .unknown
    }

    private static func parse(_ decoder: Decoder) throws -> AgentEvent {
        let fields = try decoder.container(keyedBy: Keys.self)
        func string(_ key: Keys) throws -> String { try fields.decode(String.self, forKey: key) }
        switch try string(.type) {
        case "question.requested": return .questionRequested(try QuestionRequest(from: decoder))
        case "question.answered":
            return .questionAnswered(requestId: try string(.requestId), answers: try fields.decode([String: [String]].self, forKey: .answers))
        case "question.resolved": return .questionResolved(requestId: try string(.requestId))
        case "user.text": return .userText(turnId: try string(.turnId), text: try string(.text))
        case "user.steer": return .userSteer(turnId: try string(.turnId), text: try string(.text))
        case "text.delta": return .textDelta(turnId: try string(.turnId), text: try string(.text))
        case "text.done": return .textDone(turnId: try string(.turnId), text: try string(.text))
        case "reasoning.delta": return .reasoningDelta(turnId: try string(.turnId), text: try string(.text))
        case "tool.call":
            return .toolCall(
                turnId: try string(.turnId), callId: try string(.callId), name: try string(.name),
                args: try fields.decodeIfPresent(JSONValue.self, forKey: .args) ?? .null
            )
        case "tool.result":
            return .toolResult(callId: try string(.callId), ok: try fields.decode(Bool.self, forKey: .ok), output: try string(.output))
        case "subagent.start":
            return .subagentStart(turnId: try string(.turnId), callId: try string(.callId), description: try string(.description))
        case "subagent.progress":
            return .subagentProgress(
                callId: try string(.callId),
                toolUses: try fields.decodeIfPresent(Int.self, forKey: .toolUses),
                lastTool: try fields.decodeIfPresent(String.self, forKey: .lastTool)
            )
        case "subagent.end":
            return .subagentEnd(
                callId: try string(.callId), ok: try fields.decode(Bool.self, forKey: .ok),
                report: try fields.decodeIfPresent(String.self, forKey: .report)
            )
        case "error": return .error(turnId: try fields.decodeIfPresent(String.self, forKey: .turnId), message: try string(.message))
        case "turn.done": return .turnDone(turnId: try string(.turnId), stopReason: try string(.stopReason))
        default: return .unknown
        }
    }
}

/// One stored event with its number within its session (from 1, no gaps).
struct SequencedEvent: Decodable {
    let seq: Int
    let event: AgentEvent
}
