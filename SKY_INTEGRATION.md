# Sky Module Integration Brief

For Claude Code: integrating `sky.js` into a browser-based Scorched Earth clone (HTML5 Canvas + JavaScript, hosted on GitHub Pages).

## What sky.js provides

A single `Sky` class that draws a dynamic time-of-day + weather-aware sky onto a canvas. Features:

- **Time-of-day gradient** — interpolates a 7-stop palette (night → pre-dawn → sunrise → morning → day → afternoon → sunset → dusk → night) using real sunrise/sunset times.
- **Sun and moon** travel across the sky on an arc; sun shifts orange near the horizon. Moon has craters and a soft halo.
- **Twinkling stars** fade in/out around dusk and dawn.
- **Procedurally generated clouds** using noise-displacement. Three types (puffy cumulus, stretched stratocumulus, wispy cirrus). Sun occlusion: clouds blocking the sun darken visibly and dim the whole sky.
- **Rain** — drizzle / light / moderate / heavy with appropriate density, speed, streak length, sky desaturation, and splash effects on the ground.
- **Thunderstorms** — full rain effects PLUS lightning flashes (full-canvas wash + jagged bolts every 5–30 seconds).
- **Wind** drives both cloud drift speed/direction and rain streak angle.
- **Optional weather fetch** from Open-Meteo (free, keyless, CORS-friendly) for live cloud cover, precipitation, and accurate sunrise/sunset.

## Public API

```javascript
const sky = new Sky({
    lat: 44.55,             // for weather + sun times (default: Howard, WI)
    lon: -88.05,
    useWeather: true,       // fetch live weather from Open-Meteo
    useRealSunTimes: true,  // use actual sunrise/sunset for that day
});

// Override controls (set null to use real values)
sky.timeOverride = 14;        // decimal hour, 0-24
sky.cloudOverride = 50;       // percent, 0-100
sky.precipOverride = 'heavy'; // 'none' | 'drizzle' | 'light' | 'moderate' | 'heavy' | 'thunder'

// Per-round wind: range -100 to +100 mph (sign = direction; -ve drifts west)
sky.setWindSpeed(45);

// Splash positioning: tell sky where the ground is for each column
sky.groundYFn = (x) => yourTerrainHeightFunction(x);
// or fixed:
sky.groundY = 400;

// Public getters
sky.getCurrentHour();
sky.getCurrentCloudCover();
sky.getCurrentPrecipitation();   // 'none' | 'drizzle' | 'light' | 'moderate' | 'heavy' | 'thunder'

// In your render loop:
sky.update(timestamp);        // updates weather, animates clouds/rain/lightning
sky.draw(ctx, timestamp);     // draws everything (call FIRST, before terrain/tanks)
```

The `update` method handles weather refresh internally (rate-limited to once per 30 min). A failed fetch logs once and falls back to defaults — never blocks rendering.

## Integration steps

### 1. Add sky.js to your project

```html
<script src="sky.js"></script>
<script src="game.js"></script>
```

### 2. Instantiate at game start (NOT per round)

Weather fetches once at game start and caches. Per the user's spec, do NOT re-fetch mid-game.

```javascript
// At game initialization
const sky = new Sky({
    lat: 44.55,
    lon: -88.05,
    useWeather: true,
});

// Hook ground height to terrain so rain splashes land on the surface
sky.groundYFn = (x) => terrainHeightAt(x);
```

### 3. Apply per-round settings

At the start of each round, apply the player's menu choices and the round's wind:

```javascript
function applyRoundSky(timeChoice, cloudChoice, windMph) {
    // Time
    if      (timeChoice === 'local')   sky.timeOverride = null;
    else if (timeChoice === 'dawn')    sky.timeOverride = sky.sunrise - 0.5;
    else if (timeChoice === 'sunrise') sky.timeOverride = sky.sunrise + 0.3;
    else if (timeChoice === 'noon')    sky.timeOverride = 12;
    else if (timeChoice === 'sunset')  sky.timeOverride = sky.sunset - 0.2;
    else if (timeChoice === 'night')   sky.timeOverride = 22;
    else if (timeChoice === 'random')  sky.timeOverride = Math.random() * 24;

    // Cloud cover
    if      (cloudChoice === 'local')  sky.cloudOverride = null;
    else if (cloudChoice === 'random') sky.cloudOverride = Math.floor(Math.random() * 101);
    else                               sky.cloudOverride = parseInt(cloudChoice, 10);

    // Wind drives cloud and rain motion. Sign matters: negative blows west.
    sky.setWindSpeed(windMph);
}
```

Time presets are anchored to `sky.sunrise` and `sky.sunset` (real values from Open-Meteo if available, fallback 6.5 / 19.5). This makes "Sunrise" look correct year-round in Wisconsin, not just summer.

### 4. Render order

In your game loop, draw the sky FIRST, then everything else on top:

```javascript
function render(timestamp) {
    sky.update(timestamp);
    sky.draw(ctx, timestamp);
    drawTerrain();
    drawTanks();
    drawProjectiles();
    drawHUD();
    requestAnimationFrame(render);
}
```

## Menu integration

Add new menu items to the existing match setup menu, matching the existing menu's style.

### Menu items

**Time of Day**
- Local *(default)*
- Dawn
- Sunrise
- Noon
- Sunset
- Night
- Random

**Cloud Cover**
- Local *(default)*
- 20%
- 50%
- 80%
- 100%
- Random

**Precipitation** *(suggested addition — user did not explicitly ask for this menu, only mentioned that real weather should drive it. Confirm with user whether they want this as a menu option or only ever from real weather.)*
- Local (use real weather code) *(default)*
- None
- Light Rain
- Heavy Rain
- Thunderstorm
- Random

If the user doesn't want a precipitation menu, just don't add it. In that case, only "Local" weather will ever produce rain. That's fine — `sky.precipOverride = null` is the default.

### Persistence

Save the player's last selection to localStorage so it persists across game sessions, consistent with however the existing menu handles other settings.

## Failure handling

The Open-Meteo fetch can fail for several reasons:

- Player is offline.
- Player opened the game from `file://` (browsers block fetch from `file://` origins). The module already detects this and skips silently — no warning needed.
- Open-Meteo is down or rate-limiting.

In all failure cases:
- `sky.weatherReady` stays `false`
- `sky.cloudCover` stays at 0 (clear sky)
- `sky.weatherCode` stays at 0 (no precipitation)
- `sky.sunrise` / `sky.sunset` stay at defaults (6.5 / 19.5)

The sky still renders perfectly — it just shows clear sky at fallback times. **No user-visible error needed.** This is intentional: a failed weather fetch should not interrupt the game.

## How rain/lightning are triggered

Without override, the precipitation type is derived from Open-Meteo's WMO weather code:

| WMO codes | Type | Description |
|-----------|------|-------------|
| 51-57 | drizzle | Light spray, sparse short streaks |
| 61, 80 | light | Visible rain, moderate density |
| 63, 81 | moderate | Steady rain |
| 65, 67, 82 | heavy | Pouring rain, dense long streaks |
| 95-99 | thunder | Heavy rain + lightning bolts every 5-30s |
| anything else | none | No rain |

Snow codes (71-77) are currently treated as 'none' — snow is a possible Phase 3 future addition.

When precipitation is active, the sky palette is automatically desaturated toward grey-green, stars are dimmed (rain hides stars), and the sun/moon brightness is reduced. The game doesn't need to do anything — it's automatic from `sky.draw()`.

## Performance notes

- **Cloud generation cost**: Each cloud takes ~5–15ms at creation. With 28 clouds at 100% cover, expect a one-time ~150–400ms hitch when the round starts and clouds are generated. If noticeable, spread `_makeCloud()` calls across several frames using `requestIdleCallback`.
- **Rain cost**: ~450 raindrops in heavy rain, all drawn as a single `stroke()` batch. Negligible.
- **Lightning cost**: Single fillRect plus a few line segments during the flash. Free.
- **Memory**: ~15MB total for 28 large cloud bitmaps. Acceptable for desktop, fine for modern mobile.

## Visual lessons learned (gotchas already solved in sky.js)

If Claude Code wants to modify the cloud or rain rendering:

1. **`source-atop` needs a transparent destination.** The cloud tint pass happens on a scratch offscreen canvas where everything outside the cloud silhouette IS transparent. Drawing the bitmap onto the main sky canvas first and then trying to tint with `source-atop` makes square clouds — the sky is opaque, source-atop has no transparent regions to clip to. Don't break this.

2. **Bitmap padding affects positioning.** Each cloud's bitmap is `cloudW + pad*2` wide (pad ~70px) so distortion has room to push pixels. The visible silhouette is centered in the bitmap. When positioning by `y`, subtract `pad`.

3. **Source gradient should be smooth.** The radial gradient defining cloud shape needs gentle stops (e.g., 0.95 → 0.6 → 0). Plateaus produce visible "ridges" in the displaced output.

4. **Final blur pass is essential for soft edges.** A `ctx.filter = 'blur(Npx)'` after displacement uniformly softens all edges.

5. **Rain streak angle uses wind.** `_drawRain` calculates angle from wind speed each frame. Don't bake angle into stored streak data — wind can change between rounds.

6. **Splashes use ground line, not canvas bottom.** `_getGroundY(x)` returns the ground height for any X. By default this returns `canvas.height - 4`. Hook your terrain in via `sky.groundYFn = (x) => yourTerrainAt(x)` so splashes happen on the actual ground surface.

7. **Lightning uses time deltas, not frame counts.** `_updateLightning` uses `timestamp` (passed by `update()`) for next-strike scheduling. Don't replace this with a frame counter — frame rate varies.

## Files

- `sky.js` — the module
- `sky-demo.html` — interactive preview page (sliders for time, cloud cover, wind, precipitation; presets; real-weather toggle). Useful for QA after integration. Can be deleted from the production build.

## Quick test checklist

After integration:
1. Open game → sky renders at game-current time with clouds matching local weather (or fallback if offline).
2. Set Time = Sunset, Cloud Cover = 80% → start round → orange/red sky with heavy clouds.
3. Watch a cloud drift across the sun → should darken visibly, sky dims briefly.
4. Set high wind round (e.g., 80 mph) → clouds visibly faster.
5. Try negative wind → clouds drift leftward, wraparound on left edge.
6. Force Precipitation = Heavy → rain visible, palette grey, splashes on terrain.
7. Force Precipitation = Thunder → rain plus lightning every 5-30s.
8. High wind + heavy rain → streaks angle noticeably with wind direction.
9. Disconnect internet, restart → still works fine, defaults to clear sky.
