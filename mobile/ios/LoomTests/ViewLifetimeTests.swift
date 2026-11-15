import SwiftUI
import XCTest
@testable import Loom

@MainActor
final class ViewLifetimeTests: XCTestCase {
    /// Why a question card may not keep ordinary drafts in its own lifetime: in a lazy transcript a
    /// row disappears (and may be rebuilt) merely because it was scrolled out of view.
    func testLazyTranscriptRowsDisappearWhenScrolledAway() async throws {
        let events = Locked<[String]>([])
        let hosted = try HostedWindow(ScrollView {
            LazyVStack {
                Color.red.frame(height: 120)
                    .onAppear { events.update { $0.append("appear") } }
                    .onDisappear { events.update { $0.append("disappear") } }
                ForEach(0..<200, id: \.self) { Text("row \($0)").frame(height: 60) }
            }
        })
        defer { hosted.close() }
        await hosted.settle()
        XCTAssertEqual(events.value, ["appear"])
        try await hosted.scroll(to: 6000)
        XCTAssertEqual(events.value, ["appear", "disappear"], "scrolled away, not navigated away")
    }

    /// The real conversation screen: an ordinary answer typed into a question card survives the
    /// card being scrolled away and back; its secret answer does not leave the card.
    func testQuestionDraftSurvivesScrollingInTheConversation() async throws {
        let store = AppStore(previewing: .sample)
        let scope = try XCTUnwrap(store.scope)
        let request = try XCTUnwrap(scope.timeline("s1")?.transcript.blocks.lazy.compactMap { block -> QuestionRequest? in
            if case .question(let question) = block.content { return question.request } else { return nil }
        }.first)
        var form = QuestionForm(request: request)
        form.toggle("env", .option(0))
        form.setText("key", "sk_test_secret")
        scope.keepQuestionForm(sessionId: "s1", form)

        let hosted = try HostedWindow(
            NavigationStack { ConversationView(sessionId: "s1") }.environment(store).environment(scope),
            size: CGSize(width: 390, height: 360)
        )
        defer { hosted.close() }
        await hosted.settle()
        try await hosted.scroll(to: 0)
        try await hosted.scroll(to: 100_000)
        try await hosted.scroll(to: 0)
        XCTAssertEqual(scope.questionForm(request).answers["env"], ["Sandbox"])
        XCTAssertEqual(scope.questionForm(request).text("key"), "")
    }
}
