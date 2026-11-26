import SwiftUI

struct TranscriptRow: View {
    let block: TranscriptBlock
    let sessionId: String
    let transcript: Transcript
    let readOnly: Bool

    var body: some View {
        switch block.content {
        case .user(let text):
            HStack {
                Spacer(minLength: 40)
                Text(text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(LoomStyle.quiet, in: RoundedRectangle(cornerRadius: 20))
                    .accessibilityLabel("You said: \(text)")
            }
        case .assistant(let text):
            if !text.isEmpty { MarkdownText(text: text).lineSpacing(4) }
        case .reasoning(let text):
            DisclosureGroup {
                Text(text).font(.footnote).foregroundStyle(LoomStyle.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label("Reasoning", systemImage: "brain").font(.footnote).foregroundStyle(LoomStyle.secondary).frame(minHeight: 44)
            }
        case .tool(let tool):
            ToolRow(tool: tool)
        case .subagent(let subagent):
            SubagentRow(subagent: subagent)
        case .question(let question):
            QuestionCard(sessionId: sessionId, question: question, state: transcript.state(of: question), readOnly: readOnly)
                .id(question.request.requestId)
        case .error(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.red)
                .textSelection(.enabled)
                .accessibilityLabel("Error: \(message)")
        case .turnEnded(let reason):
            Label(Self.ending(reason), systemImage: "stop.circle")
                .font(.footnote)
                .foregroundStyle(LoomStyle.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private static func ending(_ reason: String) -> String {
        switch reason {
        case "cancelled": return "Turn stopped"
        case "error": return "Turn ended with an error"
        case "limit": return "Turn reached a limit"
        case "interrupted": return "Turn interrupted — the agent's process went away"
        default: return "Turn ended"
        }
    }
}

/// A tool call folded to one line: what ran and whether it worked. Details open on demand.
private struct ToolRow: View {
    let tool: ToolCall
    private static let shown = 6000

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                if tool.args != .null { detail("Input", tool.args.pretty()) }
                if let output = tool.output, !output.isEmpty { detail("Output", output) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 8) {
                status.font(.system(size: 16)).frame(width: 20)
                Text(tool.summary.isEmpty ? tool.name : "\(tool.name) · \(tool.summary)")
                    .font(.footnote).foregroundStyle(LoomStyle.secondary).lineLimit(1).truncationMode(.middle)
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Tool \(tool.name)\(tool.summary.isEmpty ? "" : ", \(tool.summary)"), \(statusText)")
        }
        .disclosureGroupStyle(ToolDisclosureStyle())
        .tint(LoomStyle.secondary)
    }

    private var statusText: String { tool.ok == nil ? "running" : tool.ok == true ? "succeeded" : "failed" }

    @ViewBuilder private var status: some View {
        switch tool.ok {
        case nil: ProgressView().controlSize(.small)
        case true?: Image(systemName: "checkmark.circle").foregroundStyle(LoomStyle.secondary)
        case false?: Image(systemName: "xmark.octagon").foregroundStyle(.red)
        }
    }

    private func detail(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(LoomStyle.secondary)
            Text(text.count > Self.shown ? String(text.prefix(Self.shown)) + "\n… \(text.count - Self.shown) more characters not shown" : text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.bottom, 8)
    }
}

/// The whole tool label toggles details; its expanded state remains available to VoiceOver.
private struct ToolDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { configuration.isExpanded.toggle() } label: {
                configuration.label.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint(configuration.isExpanded ? "Collapse tool details" : "Expand tool details")
            if configuration.isExpanded { configuration.content }
        }
    }
}

private struct SubagentRow: View {
    let subagent: Subagent

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                if let report = subagent.report, !report.isEmpty {
                    MarkdownText(text: report)
                } else {
                    Text(subagent.ok == nil ? "Still working." : "No report.").font(.footnote).foregroundStyle(LoomStyle.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 8)
        } label: {
            HStack(spacing: 8) {
                Group {
                    switch subagent.ok {
                    case nil: ProgressView().controlSize(.small)
                    case true?: Image(systemName: "checkmark.circle").foregroundStyle(LoomStyle.secondary)
                    case false?: Image(systemName: "xmark.octagon").foregroundStyle(.red)
                    }
                }
                .font(.system(size: 16)).frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Subagent").font(.footnote.weight(.semibold)).foregroundStyle(Color.primary)
                    Text(progress).font(.caption).foregroundStyle(LoomStyle.secondary).lineLimit(2).multilineTextAlignment(.leading)
                }
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
        }
        .padding(.horizontal, 12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    private var progress: String {
        var parts = [subagent.description]
        if let uses = subagent.toolUses { parts.append(uses == 1 ? "1 tool use" : "\(uses) tool uses") }
        if subagent.ok == nil, let last = subagent.lastTool { parts.append(last) }
        return parts.joined(separator: " · ")
    }
}
