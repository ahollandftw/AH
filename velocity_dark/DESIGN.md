# Design System Document: The AnalyticHustle Framework

## 1. Overview & Creative North Star: "The Digital Dugout"
This design system is engineered to transform raw MLB data into high-stakes editorial storytelling. The Creative North Star is **"The Digital Dugout"**—an aesthetic that blends the high-tech, data-driven environment of modern sabermetrics with the electric atmosphere of a night game under stadium lights.

To move beyond the "standard dashboard" look, this system rejects the rigid, flat grid in favor of **Intentional Asymmetry**. We use overlapping data layers, "heroic" typography scales, and tonal depth to create a sense of momentum. The goal is not just to display stats, but to project the *velocity* of a home run before the bat even touches the ball.

---

## 2. Colors & Atmospheric Depth
The palette is rooted in the deep shadows of the outfield, punctuated by the "Electric Green" of a perfect launch angle.

### The Palette
- **Background & Surface:** `surface` (#041329) provides the midnight-sky base.
- **Primary Kinetic:** `primary` (#00e639) is our "Home Run" color—reserved for positive projections and high-probability trends.
- **Secondary Support:** `secondary` (#adc8f5) acts as the cool, professional counterpoint for historical data.

### The "No-Line" Rule
**Explicit Instruction:** Designers are prohibited from using 1px solid borders to section content. Boundaries must be defined through background color shifts. Use `surface-container-low` for secondary sections sitting on a `surface` background. The eye should perceive structure through value changes, not wireframes.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. 
- Use `surface-container-lowest` (#010e24) for the most recessed, "background" data tracks.
- Use `surface-container-highest` (#27354c) for active, interactive "cards" that need to pop.
- **The Glass & Gradient Rule:** For floating projection cards, apply a `surface-variant` with a 60% opacity and a 20px backdrop-blur. Main Action buttons must use a linear gradient from `primary` (#00e639) to `on-primary-container` (#009722) at a 135-degree angle to provide a "tactile glow."

---

## 3. Typography: Athletic Authority
We utilize a triple-font system to separate narrative, data, and utility.

*   **Display & Headlines (Lexend):** A wide, geometric sans-serif that mimics the bold weight of jersey numbers. Use `display-lg` (3.5rem) for projected distances to give them an unmissable, "monumental" feel.
*   **Body & Titles (Inter):** Our workhorse. `title-lg` (1.375rem) provides high-readability for player names, while `body-md` handles the scouting reports.
*   **Stats & Metrics (Space Grotesk):** Specifically chosen for its tabular qualities. Use `label-md` for launch angles and exit velocities. The technical, futuristic feel of Space Grotesk ensures the numbers look like they were calculated by an elite AI.

---

## 4. Elevation & Tonal Layering
In this system, elevation is a product of light, not lines.

- **The Layering Principle:** To lift a player's "Stat Card," place a `surface-container-high` container on top of a `surface-container-low` page section. 
- **Ambient Shadows:** When a card is "in flight" (hovered or active), use a diffuse shadow: `offset: 0 20px, blur: 40px, color: rgba(0, 0, 0, 0.4)`. The shadow should feel like a soft glow emanating from the darkness.
- **The Ghost Border Fallback:** If high-density data requires containment, use the `outline-variant` (#44474d) at 15% opacity. It should be felt, not seen.
- **Glassmorphism:** Use semi-transparent layers for the "Stat Overlay" on player photos. This allows the high-action photography to bleed through the data, maintaining the "Sporting" energy.

---

## 5. Components

### Cards & Data Modules
*   **The "No-Divider" Rule:** Forbid the use of divider lines within lists. Use the `spacing-4` (0.9rem) or `spacing-6` (1.3rem) scale to create visual breathing room between players.
*   **Projection Cards:** Use `surface-container-highest` with a subtle top-left to bottom-right gradient (using `surface-bright`).

### Buttons
*   **Primary (The "Launch" Button):** Full `primary` (#00e639) fill with `on-primary` (#003907) text. Bold, all-caps `title-sm` typography.
*   **Secondary (The "Compare" Button):** `surface-variant` background with a `primary` ghost-border at 20% opacity.

### Chips & Tags
*   **Trend Chips:** Use `on-primary-container` (#009722) for positive "Hot Streaks." These should have a `round-full` (9999px) radius to contrast against the sharp-edged, "athletic" cards.

### Input Fields
*   **Search/Filter:** Use `surface-container-lowest`. On focus, transition the background to `surface-bright` and add a `primary` 1px ghost-border. No heavy shadows.

### Interactive Data Visuals (The "Spray Chart")
*   Data points should utilize the `primary` token for HR projections and `secondary` for foul balls. Use `surface-tint` to create a soft outer glow on projected landing spots.

---

## 6. Do's and Don'ts

### Do:
*   **Use Asymmetry:** Offset player images so they break the bounds of their container cards. It creates "kinetic" energy.
*   **Embrace the Dark:** Allow large areas of `surface` (#041329) to exist. The "Deep Navy" is the soul of the app.
*   **Scale the Type:** Use `display-lg` for the "Big Number" (e.g., 450ft). Make it the hero of the page.

### Don't:
*   **Don't use white backgrounds:** This is a night-mode-first experience. Pure white should only be used for high-priority text.
*   **Don't use sharp shadows:** If a card looks like it has a "drop shadow" from 2005, it’s wrong. Shadows must be ambient and vast.
*   **Don't use standard tables:** Avoid the "Excel" look. Use spaced-out list items with background shifts to denote rows.