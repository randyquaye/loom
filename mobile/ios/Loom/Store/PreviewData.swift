#if DEBUG
import Foundation

/// Invented sample data for screenshots, used only when a DEBUG build is launched with
/// `-LoomPreview`. It is not a sign-in: the preview store has no session and no connection,
/// and none of this file exists in a release build.
struct PreviewData {
    let account: Account
    let projects: [ProjectRow]
    let workspaces: [String: [WorkspaceRow]]
    let sessions: [String: [SessionRow]]
    let power: [String: WorkspacePower]
    let running: [String: String]
    let unread: [String: SessionUnread]
    let timelines: [String: SessionTimeline]
    let queues: [String: [QueuedMessage]]
    let files: [String: [FileNode]]
    let fileText: String
    let changes: [ChangeEntry]
    let diff: String

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }

    private static func timeline(_ events: [String]) -> SessionTimeline {
        var timeline = SessionTimeline()
        for (index, json) in events.enumerated() {
            timeline.ingest(seq: index + 1, event: decode(json))
        }
        return timeline
    }

    private static func workspace(_ id: String, _ project: String, _ name: String, state: String = "ready", archived: Bool = false, bot: String? = nil) -> String {
        let shared = bot.map { #","bot":{"id":"bot-review","access":"\#($0)"}"# } ?? ""
        return #"{"id":"\#(id)","projectId":"\#(project)","name":"\#(name)","branch":"loom/\#(name)","archived":\#(archived),"state":"\#(state)","runtime":"container"\#(shared)}"#
    }

    private static func session(_ id: String, _ workspace: String, _ title: String, backend: String = "claude", model: String = "claude-opus-5-5") -> String {
        #"{"id":"\#(id)","workspaceId":"\#(workspace)","backend":"\#(backend)","model":"\#(model)","effort":"high","title":"\#(title)","createdAt":1800000000000,"closedAt":null}"#
    }

    static let sample = PreviewData(
        account: Account(email: "developer@example.com", origin: "https://loom.example.com", trustDomain: "example.com"),
        projects: decode(#"[{"id":"p1","name":"storefront"},{"id":"p2","name":"billing-service"}]"#),
        workspaces: [
            "p1": decode("[\(workspace("w1", "p1", "checkout-retries")),\(workspace("w2", "p1", "dependency-review", bot: "view")),\(workspace("w3", "p1", "release-notes", bot: "control"))]"),
            "p2": decode("[\(workspace("w4", "p2", "invoice-rounding")),\(workspace("w5", "p2", "ledger-migration", state: "error")),\(workspace("w6", "p2", "old-spike", archived: true))]")
        ],
        sessions: [
            "w1": decode("[\(session("s6", "w1", "Safe checkout retries")),\(session("s1", "w1", "Retry failed card captures")),\(session("s2", "w1", "Review flaky checkout test", backend: "codex", model: "gpt-5.2-codex")),\(session("s5", "w1", "Capture validation"))]"),
            "w2": decode("[\(session("s3", "w2", "Weekly dependency audit"))]"),
            "w3": decode("[\(session("s4", "w3", "Draft 4.2 release notes"))]"),
            "w4": []
        ],
        power: [
            "w1": WorkspacePower(state: "running", error: nil), "w2": WorkspacePower(state: "running", error: nil),
            "w3": WorkspacePower(state: "stopped", error: nil), "w4": WorkspacePower(state: "stopped", error: nil)
        ],
        running: ["s1": "w1"],
        unread: ["s3": SessionUnread(workspaceId: "w2", seq: 4)],
        timelines: [
            "s6": timeline([
                #"{"type":"user.text","turnId":"chat-demo","text":"Make retries safe without charging twice."}"#,
                #"{"type":"text.done","turnId":"chat-demo","text":"The retry path can submit the same payment twice when a request times out.\n\nI'll keep one payment identity across retries and check the timeout path."}"#,
                #"{"type":"tool.call","turnId":"chat-demo","callId":"demo-read","name":"read_file","args":{"path":"capture.ts"}}"#,
                #"{"type":"tool.result","turnId":"chat-demo","callId":"demo-read","ok":true,"output":"Synthetic preview source. No file was read."}"#,
                #"{"type":"user.text","turnId":"chat-demo-2","text":"Keep the existing API."}"#,
                #"{"type":"text.done","turnId":"chat-demo-2","text":"I'll preserve the API and update the retry handling in src/payments/capture.ts.\n\nYou can also read the [capture implementation](src/payments/capture.ts#L6)."}"#
            ]),
            "s1": timeline([
                #"{"type":"user.text","turnId":"t1","text":"Card captures that time out are dropped. Retry them with backoff, and keep it idempotent."}"#,
                #"{"type":"text.done","turnId":"t1","text":"I'll look at how captures are submitted today, then add a bounded retry."}"#,
                #"{"type":"tool.call","turnId":"t1","callId":"c1","name":"grep","args":{"pattern":"captureCharge","path":"src/payments"}}"#,
                #"{"type":"tool.result","turnId":"t1","callId":"c1","ok":true,"output":"src/payments/capture.ts:41: export async function captureCharge(order: Order)\nsrc/payments/worker.ts:18: await captureCharge(order)"}"#,
                #"{"type":"tool.call","turnId":"t1","callId":"c2","name":"read_file","args":{"path":"src/payments/capture.ts"}}"#,
                #"{"type":"tool.result","turnId":"t1","callId":"c2","ok":true,"output":"export async function captureCharge(order: Order) {\n  return gateway.capture(order.chargeId, order.total)\n}"}"#,
                ###"{"type":"text.done","turnId":"t1","text":"## Plan\n\nCaptures go out once with no retry. I'll make three changes:\n\n1. Send an **idempotency key** derived from the order, so a retried capture can never charge twice.\n2. Retry timeouts up to three times with exponential backoff.\n3. Record the final outcome on the order.\n\n```ts\nexport async function captureCharge(order: Order) {\n  return withRetry({ attempts: 3, baseMs: 500 }, () =>\n    gateway.capture(order.chargeId, order.total, { idempotencyKey: `capture-${order.id}` })\n  )\n}\n```\n\nBefore I run the integration tests I need to know where they should point."}"###,
                #"{"type":"tool.call","turnId":"t1","callId":"c3","name":"bash","args":{"command":"pnpm test payments --run"}}"#,
                #"{"type":"tool.result","turnId":"t1","callId":"c3","ok":false,"output":"FAIL src/payments/capture.test.ts\n  ✕ retries a timed out capture (12 ms)\n    Expected: 3 attempts\n    Received: 1"}"#,
                #"{"type":"question.requested","requestId":"q1","turnId":"t1","blocking":true,"questions":[{"id":"env","header":"Target","question":"Which gateway environments should the integration tests use?","options":[{"label":"Sandbox","description":"Simulated cards, no money moves"},{"label":"Staging","description":"Shared test merchant account"}],"isOther":true,"multiSelect":true},{"id":"key","header":"Access","question":"Paste a sandbox API key for the gateway.","isSecret":true}]}"#
            ]),
            "s5": timeline([
                ###"{"type":"text.done","turnId":"formatting","text":"## Capture validation\n\nThe retry keeps the **same capture key**.\n\n| Check | Outcome |\n| --- | --- |\n| Timeout | Retried |\n| Duplicate | `Deduplicated` |\n\n1. Keep the original key.\n   - Repeat safely after a timeout.\n2. Record the outcome.\n\n> Tests passed using synthetic orders.\n\n```ts\nawait capture(order, { attempts: 3 })\n```"}"###,
                #"{"type":"turn.done","turnId":"formatting","stopReason":"end"}"#
            ]),
            "s3": timeline([
                #"{"type":"user.text","turnId":"t1","text":"Run the weekly dependency audit."}"#,
                #"{"type":"subagent.start","turnId":"t1","callId":"a1","description":"Check advisories for direct dependencies"}"#,
                #"{"type":"subagent.progress","turnId":"t1","callId":"a1","toolUses":14,"lastTool":"bash"}"#,
                #"{"type":"subagent.end","turnId":"t1","callId":"a1","ok":true,"report":"Two advisories affect direct dependencies:\n\n- `fast-xml` 4.2.1: upgrade to 4.4.1\n- `tar-stream` 2.1.0: upgrade to 3.1.7"}"#,
                #"{"type":"text.done","turnId":"t1","text":"Two direct dependencies have advisories. Both have compatible fixes, and I opened nothing yet.\n\n> Nothing was changed in this run."}"#,
                #"{"type":"turn.done","turnId":"t1","stopReason":"end"}"#
            ])
        ],
        queues: ["s1": [QueuedMessage(id: "m1", text: "Also add a metric for exhausted retries.")]],
        files: [
            "": decode(#"[{"name":"src","path":"src","kind":"dir"},{"name":"test","path":"test","kind":"dir"},{"name":"README.md","path":"README.md","kind":"file"},{"name":"package.json","path":"package.json","kind":"file"}]"#),
            "src": decode(#"[{"name":"payments","path":"src/payments","kind":"dir"},{"name":"index.ts","path":"src/index.ts","kind":"file"}]"#),
            "src/payments": decode(#"[{"name":"capture.ts","path":"src/payments/capture.ts","kind":"file"},{"name":"worker.ts","path":"src/payments/worker.ts","kind":"file"}]"#)
        ],
        fileText: """
        import { gateway } from './gateway'
        import { withRetry } from '../lib/retry'
        import type { Order } from '../orders'

        /** Captures an authorized charge. Safe to call again for the same order. */
        export async function captureCharge(order: Order) {
          return withRetry({ attempts: 3, baseMs: 500 }, () =>
            gateway.capture(order.chargeId, order.total, { idempotencyKey: `capture-${order.id}` })
          )
        }
        """,
        changes: decode(#"[{"path":"src/payments/capture.ts","status":"modified","staged":false,"unstaged":true},{"path":"src/lib/retry.ts","status":"untracked","staged":false,"unstaged":false},{"path":"src/payments/legacy-capture.ts","status":"deleted","staged":true,"unstaged":false}]"#),
        diff: """
        diff --git a/src/payments/capture.ts b/src/payments/capture.ts
        --- a/src/payments/capture.ts
        +++ b/src/payments/capture.ts
        @@ -1,6 +1,9 @@
         import { gateway } from './gateway'
        +import { withRetry } from '../lib/retry'
         import type { Order } from '../orders'

         export async function captureCharge(order: Order) {
        -  return gateway.capture(order.chargeId, order.total)
        +  return withRetry({ attempts: 3, baseMs: 500 }, () =>
        +    gateway.capture(order.chargeId, order.total, { idempotencyKey: `capture-${order.id}` })
        +  )
         }
        """
    )
}
#endif
