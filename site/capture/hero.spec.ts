import { expect, test } from '@playwright/test'
import { film } from './recorder'
import { heroStoryboard } from './storyboard'

/** Not a test: records the hero video, a Claude turn typed, sent and played live. */
test('record hero video', async () => {
  await film({
    name: 'hero',
    live: true,
    steps: heroStoryboard(),
    loop: 'open-on-end',
    width: 1920, // twice the hero stage's 960 CSS px
    done: (win) => expect(win.locator('.chat-group-head').last()).toHaveAttribute('aria-expanded', 'false')
  })
})
