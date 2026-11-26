package dev.loom.app.android.runner

import dev.loom.app.android.auth.Origin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The exact upgrade request the host's admission check reads. */
class RunnerWireTest {
    private val request = runnerSocketRequest(Origin("loom.example.com"), "token-1")

    @Test
    fun upgradeGoesToTheRunnerPathOfTheSignedInHostOverTls() {
        assertEquals("https://loom.example.com/v1/ws", request.url.toString())
    }

    @Test
    fun upgradeAsksForBotsAndMobileTheWayTheHostParsesThem() {
        // src/main/runner/server.ts splits on ',' and trims each name.
        val names = request.headers("x-loom-capabilities").single().split(',').map { it.trim() }
        assertEquals(listOf("bots.v1", "mobile.v1"), names)
    }

    @Test
    fun upgradeCarriesTheBearerAndNeverAnOrigin() {
        assertEquals("Bearer token-1", request.header("Authorization"))
        // The host refuses any Origin outright: only browsers send one.
        assertNull(request.header("Origin"))
        assertEquals(setOf("Authorization", "x-loom-capabilities"), request.headers.names())
    }
}
