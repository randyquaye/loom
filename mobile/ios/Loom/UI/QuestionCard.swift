import SwiftUI

/// An agent's question. A transcript row can be dropped and rebuilt just by scrolling, so what is
/// typed for an ordinary question is kept by the sign-in's scope (in memory, until the question
/// closes or the sign-in ends). Secret answers are never kept there: they live only in this card's
/// own state and are forgotten once sent, when the question closes, or when the card goes away.
struct QuestionCard: View {
    @Environment(AccountScope.self) private var scope
    let sessionId: String
    let question: QuestionBlock
    let state: QuestionState
    let readOnly: Bool
    /// Answers to this question's secret parts only.
    @State private var secrets: QuestionForm
    @State private var sending = false
    @State private var expanded = false

    init(sessionId: String, question: QuestionBlock, state: QuestionState, readOnly: Bool) {
        self.sessionId = sessionId
        self.question = question
        self.state = state
        self.readOnly = readOnly
        _secrets = State(initialValue: QuestionForm(request: question.request))
    }

    private var request: QuestionRequest { question.request }
    private var isApproval: Bool { request.purpose == "approval" }
    private var waiting: Bool { state == .open || state == .followUp }
    private var submitted: Bool { scope.isAnswerSent(request.requestId) }
    private var locked: Bool { readOnly || !waiting || sending || submitted }
    private var form: QuestionForm { secrets.secrets(over: scope.questionForm(request)) }
    private var needsExpansion: Bool {
        request.questions.count > 1 || request.questions.contains { $0.isSecret || $0.options.count > 4 }
    }

    private func update(_ change: (inout QuestionForm) -> Void) {
        var next = form
        change(&next)
        secrets = next.secrets(over: QuestionForm(request: request))
        scope.keepQuestionForm(sessionId: sessionId, next)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: isApproval ? "hand.raised" : "questionmark.bubble")
                .font(.subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            if needsExpansion && waiting && !submitted && !expanded {
                if let first = request.questions.first { Text(first.question).font(.body) }
                Button(isApproval ? "Review approval" : "Answer questions") { expanded = true }
                    .font(.subheadline.weight(.medium)).frame(minHeight: 44)
            } else if submitted && waiting {
                Text("Answer sent. Waiting for the agent.").font(.subheadline).foregroundStyle(LoomStyle.secondary)
            } else {
                ForEach(request.questions) { asked in
                    VStack(alignment: .leading, spacing: 8) {
                        if !asked.header.isEmpty {
                            Text(asked.header).font(.caption.weight(.medium)).foregroundStyle(LoomStyle.secondary)
                        }
                        Text(asked.question).font(.body).textSelection(.enabled)
                        if state == .answered {
                            answered(asked)
                        } else {
                            input(asked)
                        }
                    }
                }
                footer
                if needsExpansion && expanded && waiting && !submitted {
                    Button("Hide questions") { expanded = false; secrets.clear() }
                        .font(.footnote).frame(minHeight: 44)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LoomStyle.quiet, in: RoundedRectangle(cornerRadius: 18))
        .onChange(of: state) { _, next in
            // Nothing typed outlives the question it was typed for; the scope drops its part too.
            if next == .answered || next == .closed { secrets.clear() }
        }
        .onDisappear { secrets.clear() }
    }

    private var title: String {
        switch state {
        case .answered: return isApproval ? "Approval given" : "Answered"
        case .closed: return isApproval ? "Approval no longer needed" : "Question closed"
        case .followUp: return "The agent asked, then finished its turn"
        case .open: return isApproval ? "The agent needs your approval" : "The agent is asking"
        }
    }

    @ViewBuilder private func answered(_ asked: QuestionRequest.Question) -> some View {
        let values = asked.isSecret ? ["Hidden"] : (question.answers?[asked.id] ?? [])
        Label(values.isEmpty ? "No answer recorded" : values.joined(separator: ", "), systemImage: asked.isSecret ? "lock" : "checkmark")
            .font(.subheadline)
            .foregroundStyle(LoomStyle.secondary)
    }

    @ViewBuilder private func input(_ asked: QuestionRequest.Question) -> some View {
        if !asked.options.isEmpty {
            VStack(spacing: 8) {
                ForEach(Array(asked.options.enumerated()), id: \.offset) { index, option in
                    choice(asked, .option(index), label: option.label, detail: option.description)
                }
                if asked.isOther { choice(asked, .other, label: "Other", detail: "") }
            }
            if asked.multiSelect {
                Text("Choose any that apply.").font(.caption).foregroundStyle(LoomStyle.secondary)
            }
        }
        if asked.options.isEmpty || form.isSelected(asked.id, .other) {
            let text = Binding(get: { form.text(asked.id) }, set: { value in update { $0.setText(asked.id, value) } })
            Group {
                if asked.isSecret {
                    SecureField("Secret answer", text: text)
                        .textContentType(.password)
                        .accessibilityLabel("Secret answer to: \(asked.question)")
                } else {
                    TextField("Your answer", text: text, axis: .vertical)
                        .lineLimit(1...5)
                        .accessibilityLabel("Answer to: \(asked.question)")
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(.separator)))
            .disabled(locked)
            if asked.isSecret {
                Label("Sent to the agent. Hidden in question history.", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(LoomStyle.secondary)
            }
        }
    }

    private func choice(_ asked: QuestionRequest.Question, _ value: QuestionForm.Choice, label: String, detail: String) -> some View {
        let selected = form.isSelected(asked.id, value)
        let symbol = asked.multiSelect ? (selected ? "checkmark.square.fill" : "square") : (selected ? "largecircle.fill.circle" : "circle")
        return Button {
            update { $0.toggle(asked.id, value) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: symbol).foregroundStyle(selected ? Color.accentColor : LoomStyle.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(Color.primary)
                    if !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(LoomStyle.secondary) }
                }
                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? Color.accentColor : Color(.separator)))
        }
        .buttonStyle(.plain)
        .disabled(locked)
        .accessibilityLabel(detail.isEmpty ? label : "\(label). \(detail)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private var footer: some View {
        if state == .answered {
            EmptyView()
        } else if state == .closed {
            Text(isApproval ? "This request ended with its turn and can no longer be approved." : "This question is no longer waiting for an answer.")
                .font(.footnote)
                .foregroundStyle(LoomStyle.secondary)
        } else if readOnly {
            Label("View only. Someone with control of this workspace can answer.", systemImage: "eye")
                .font(.footnote)
                .foregroundStyle(LoomStyle.secondary)
        } else {
            if let error = scope.actionError("question:\(request.requestId)") {
                Label("Not sent. \(error)", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
            }
            Button(action: submit) {
                HStack {
                    Spacer()
                    if sending { ProgressView().padding(.trailing, 6) }
                    Text(buttonTitle).fontWeight(.semibold)
                    Spacer()
                }
                .frame(minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .disabled(locked || !form.isReady || !scope.canWrite(scope.session(sessionId)?.workspaceId ?? ""))
            if scope.connection != .connected {
                Text("Not connected. Your answer can be sent when the connection is back.").font(.footnote).foregroundStyle(LoomStyle.secondary)
            }
        }
    }

    private var buttonTitle: String {
        if submitted { return "Sent — waiting for the agent" }
        if sending { return "Sending…" }
        if state == .followUp { return "Send follow-up" }
        return isApproval ? "Submit approval" : "Submit answer"
    }

    private func submit() {
        guard !locked, form.isReady else { return }
        sending = true
        let answers = form.answers
        Task {
            let accepted = await scope.answer(sessionId: sessionId, requestId: request.requestId, answers: answers)
            sending = false
            // Sent once. The card closes when the runner reports the answer; it is never re-sent from here.
            if accepted { secrets.clear() }
        }
    }
}
