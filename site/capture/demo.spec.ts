import { test } from '@playwright/test'
import { film } from './recorder'
import { demoStoryboard } from './storyboard'

/**
 * Not a test: records the full demo behind "See how it works" on the whole window. Starts on
 * the hero's final state so the site can crossfade between them. Needs network for the clone.
 */
test('record demo video', async () => {
  await film({
    name: 'demo',
    live: false,
    steps: demoStoryboard(),
    loop: 'fade-to-start',
    width: 2400, // twice the 1200 CSS px the window can reach on the site
    pointer: { x: 0.5, y: 0.72 },
    hold: 2500,
    maxBytes: 3_500_000,
    // Hidden until it can play; the hero loop covers the wait.
    poster: false
  })
})
