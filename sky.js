// sky.js - Dynamic time-of-day + weather-aware sky for canvas games
// Usage:
//   const sky = new Sky({ lat: 44.55, lon: -88.05 });
//   // in your game loop:
//   sky.update(timestamp);
//   sky.draw(ctx, timestamp);

class Sky {
    constructor(options = {}) {
        // Location for weather + sunrise/sunset (defaults to Howard, WI)
        this.lat = options.lat ?? 44.55;
        this.lon = options.lon ?? -88.05;

        this.useWeather = options.useWeather ?? true;
        this.useRealSunTimes = options.useRealSunTimes ?? true;

        // Debug overrides - set to a number to force these values
        this.timeOverride = null;        // hours 0-24 (e.g., 18.5 for 6:30 PM)
        this.cloudOverride = null;       // 0-100
        this.precipOverride = null;      // null=use weather code; or 'none'/'drizzle'/'light'/'moderate'/'heavy'/'thunder'

        // Sun times (decimal hours). Defaults are reasonable for mid-latitudes.
        this.sunrise = 6.5;
        this.sunset = 19.5;

        // Weather state
        this.cloudCover = 0;
        this.weatherCode = 0;
        this.weatherReady = false;
        this.lastWeatherFetch = 0;
        this.weatherFetchInterval = 30 * 60 * 1000; // 30 min

        // Wind state (set externally via setWindSpeed; affects rain angle and cloud drift)
        this._windMph = 0;
        this._windDirection = 1;

        // Ground line for splash effects. Game should set this per column;
        // for demo/fallback we use a single Y value (canvas bottom by default).
        this.groundY = null;
        this.groundYFn = null;  // optional fn(x) → y for terrain-aware splashes

        // Visual state
        this.stars = [];
        this.clouds = [];
        this.raindrops = [];
        this.splashes = [];
        this.nextLightningAt = 0;
        this.lightningPhase = 0;     // 0 = no flash, 1 = peak, fades to 0
        this.lightningBolt = null;
        this.lastWidth = 0;
        this.lastHeight = 0;
        this._lastTimestamp = 0;

        if (this.useWeather) this.fetchWeather();
    }

    // ---------- Weather ----------

    async fetchWeather() {
        const now = Date.now();
        if (now - this.lastWeatherFetch < this.weatherFetchInterval && this.weatherReady) return;
        this.lastWeatherFetch = now;

        try {
            const url =
                `https://api.open-meteo.com/v1/forecast` +
                `?latitude=${this.lat}&longitude=${this.lon}` +
                `&current=cloud_cover,weather_code` +
                `&daily=sunrise,sunset` +
                `&timezone=auto`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            this.cloudCover = data.current?.cloud_cover ?? 0;
            this.weatherCode = data.current?.weather_code ?? 0;

            if (this.useRealSunTimes && data.daily?.sunrise?.[0]) {
                this.sunrise = this._isoToDecimalHour(data.daily.sunrise[0]);
                this.sunset = this._isoToDecimalHour(data.daily.sunset[0]);
            }

            this.weatherReady = true;
            this._regenerateClouds();
        } catch (err) {
            console.warn('[Sky] weather fetch failed, using defaults:', err.message);
        }
    }

    _isoToDecimalHour(iso) {
        // "2026-04-27T06:12" -> 6.2
        const t = iso.split('T')[1];
        const [h, m] = t.split(':').map(Number);
        return h + m / 60;
    }

    // ---------- Time of day ----------

    getCurrentHour() {
        if (this.timeOverride !== null) return this.timeOverride;
        const d = new Date();
        return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    }

    getCurrentCloudCover() {
        return this.cloudOverride !== null ? this.cloudOverride : this.cloudCover;
    }

    // ---------- Precipitation ----------

    // Maps WMO weather code -> precipitation type
    // Codes: https://open-meteo.com/en/docs#weathervariables
    getCurrentPrecipitation() {
        if (this.precipOverride !== null) return this.precipOverride;
        const c = this.weatherCode;
        if (c >= 95) return 'thunder';                          // 95-99: thunderstorms
        if (c === 65 || c === 67 || c === 82) return 'heavy';   // heavy rain / showers
        if (c === 63 || c === 81) return 'moderate';
        if (c === 61 || c === 80) return 'light';
        if (c >= 51 && c <= 57) return 'drizzle';
        // 71-77 are snow codes - treated as 'none' for now (snow is Phase 3)
        return 'none';
    }

    // Returns config for current precipitation type:
    //   { count, speed, length, alpha, splashChance, desat }
    // count    = target number of active raindrops
    // speed    = pixels/sec downward base velocity
    // length   = streak length in px
    // alpha    = streak opacity 0-1
    // splashChance = probability per raindrop landing of spawning a splash
    // desat    = how much to flatten/grey the sky palette (0-1)
    _precipConfig() {
        const type = this.getCurrentPrecipitation();
        const w = this.lastWidth || 900;
        const h = this.lastHeight || 500;
        const area = (w * h) / (900 * 500);  // scale density with canvas size
        switch (type) {
            case 'drizzle':
                return { type, count: Math.floor(80 * area),  speed: 280, length: 4,  alpha: 0.35, splashChance: 0.05, desat: 0.25 };
            case 'light':
                return { type, count: Math.floor(160 * area), speed: 480, length: 7,  alpha: 0.5,  splashChance: 0.15, desat: 0.4 };
            case 'moderate':
                return { type, count: Math.floor(280 * area), speed: 620, length: 10, alpha: 0.6,  splashChance: 0.25, desat: 0.55 };
            case 'heavy':
                return { type, count: Math.floor(450 * area), speed: 780, length: 14, alpha: 0.7,  splashChance: 0.4,  desat: 0.7 };
            case 'thunder':
                return { type, count: Math.floor(420 * area), speed: 760, length: 13, alpha: 0.7,  splashChance: 0.4,  desat: 0.75 };
            default:
                return { type: 'none', count: 0, speed: 0, length: 0, alpha: 0, splashChance: 0, desat: 0 };
        }
    }

    // Returns the ground Y value for a given screen X
    _getGroundY(x) {
        if (this.groundYFn) return this.groundYFn(x);
        if (this.groundY !== null) return this.groundY;
        return this.lastHeight - 4;  // fallback: bottom of canvas
    }

    // Returns palette {top, mid, bot} interpolated across time.
    // Uses real sunrise/sunset to bend the schedule realistically.
    _getPalette(hour) {
        const palettes = {
            night:    { top: [5, 8, 24],     mid: [15, 20, 56],   bot: [26, 31, 72] },
            preDawn:  { top: [22, 22, 60],   mid: [60, 40, 80],   bot: [120, 70, 90] },
            sunrise:  { top: [120, 140, 200], mid: [240, 160, 130], bot: [255, 200, 120] },
            morning:  { top: [110, 170, 220], mid: [180, 215, 240], bot: [255, 240, 210] },
            day:      { top: [60, 130, 200],  mid: [120, 180, 230], bot: [185, 220, 240] },
            afternoon:{ top: [70, 130, 195],  mid: [140, 180, 220], bot: [220, 220, 210] },
            sunset:   { top: [60, 50, 110],   mid: [220, 100, 90],  bot: [250, 175, 95] },
            dusk:     { top: [15, 18, 50],    mid: [55, 38, 90],    bot: [120, 60, 100] },
        };

        const sr = this.sunrise;
        const ss = this.sunset;

        // Time anchors (in decimal hours)
        const stops = [
            { h: 0,            p: palettes.night },
            { h: sr - 1.5,     p: palettes.night },
            { h: sr - 0.5,     p: palettes.preDawn },
            { h: sr + 0.3,     p: palettes.sunrise },
            { h: sr + 1.5,     p: palettes.morning },
            { h: sr + 4,       p: palettes.day },
            { h: ss - 4,       p: palettes.day },
            { h: ss - 1.5,     p: palettes.afternoon },
            { h: ss - 0.2,     p: palettes.sunset },
            { h: ss + 0.8,     p: palettes.dusk },
            { h: ss + 2,       p: palettes.night },
            { h: 24,           p: palettes.night },
        ];

        // Find surrounding stops
        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i], b = stops[i + 1];
            if (hour >= a.h && hour <= b.h) {
                const t = (hour - a.h) / (b.h - a.h || 1);
                return this._lerpPalette(a.p, b.p, t);
            }
        }
        return palettes.night;
    }

    _lerpPalette(a, b, t) {
        return {
            top: this._lerp3(a.top, b.top, t),
            mid: this._lerp3(a.mid, b.mid, t),
            bot: this._lerp3(a.bot, b.bot, t),
        };
    }

    _lerp3(a, b, t) {
        return [
            Math.round(a[0] + (b[0] - a[0]) * t),
            Math.round(a[1] + (b[1] - a[1]) * t),
            Math.round(a[2] + (b[2] - a[2]) * t),
        ];
    }

    _rgb(c, alpha = 1) {
        return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
    }

    // 0 = full daylight, 1 = full night - drives star alpha
    _nightAmount(hour) {
        const sr = this.sunrise;
        const ss = this.sunset;
        if (hour < sr - 1) return 1;
        if (hour < sr + 0.5) return 1 - (hour - (sr - 1)) / 1.5;
        if (hour < ss - 0.5) return 0;
        if (hour < ss + 1.5) return (hour - (ss - 0.5)) / 2;
        return 1;
    }

    // ---------- Generation ----------

    _ensureGenerated(width, height) {
        if (width === this.lastWidth && height === this.lastHeight) return;
        this.lastWidth = width;
        this.lastHeight = height;
        this._generateStars(width, height);
        this._regenerateClouds();
    }

    _generateStars(width, height) {
        this.stars = [];
        // Density scales with canvas size
        const count = Math.floor((width * height) / 5000);
        for (let i = 0; i < count; i++) {
            this.stars.push({
                x: Math.random() * width,
                y: Math.random() * height * 0.75, // upper 3/4
                size: Math.random() * 1.6 + 0.3,
                phase: Math.random() * Math.PI * 2,
                speed: 0.5 + Math.random() * 2.5,
                bright: Math.random() < 0.08, // a few bright "showcase" stars
            });
        }
    }

    _regenerateClouds() {
        if (!this.lastWidth) return;
        const cover = this.getCurrentCloudCover();
        const target = Math.floor((cover / 100) * 28);
        this.clouds = [];
        for (let i = 0; i < target; i++) {
            this.clouds.push(this._makeCloud(true));
        }
    }

    _makeCloud(randomX) {
        const w = this.lastWidth;
        const h = this.lastHeight;

        // Pick a cloud type for variety
        const roll = Math.random();
        let type, cloudW, cloudH, displaceScale, opacity;
        if (roll < 0.5) {
            // Puffy cumulus - tall, lumpy, well-defined
            type = 'puffy';
            cloudW = 250 + Math.random() * 320;
            cloudH = 120 + Math.random() * 80;
            displaceScale = 40 + Math.random() * 25;
            opacity = 0.92;
        } else if (roll < 0.82) {
            // Stretched stratocumulus - wide, lower profile
            type = 'stretched';
            cloudW = 450 + Math.random() * 450;
            cloudH = 80 + Math.random() * 60;
            displaceScale = 32 + Math.random() * 20;
            opacity = 0.85;
        } else {
            // Wispy cirrus - thin, translucent, heavily distorted
            type = 'wispy';
            cloudW = 350 + Math.random() * 350;
            cloudH = 45 + Math.random() * 35;
            displaceScale = 50 + Math.random() * 30;
            opacity = 0.55;
        }

        // Pad bitmap so distortion has room to push pixels around
        const pad = Math.ceil(displaceScale * 1.6) + 8;
        const bmpW = Math.ceil(cloudW + pad * 2);
        const bmpH = Math.ceil(cloudH + pad * 2);

        const bitmap = this._renderCloudBitmap(bmpW, bmpH, cloudW, cloudH, pad, displaceScale, type);

        return {
            x: randomX ? Math.random() * w : -bmpW,
            // y is bitmap top-left. Subtract pad so the visible cloud silhouette
            // (which is centered in the bitmap with `pad` of empty space around it)
            // appears in the upper third of the sky.
            y: -pad + 10 + Math.random() * h * 0.20,
            width: cloudW,         // the visible cloud width (without padding)
            height: cloudH,
            bmpW, bmpH,
            pad,
            type,
            opacity,
            speed: 0.04 + Math.random() * 0.1,
            bitmap,
        };
    }

    // Build a cloud bitmap by:
    // 1. Drawing a soft alpha blob (the "source shape")
    // 2. Sampling a coherent 2D noise field
    // 3. For each pixel of the output, sampling the source at (x + noiseX, y + noiseY)
    // This is the canvas equivalent of SVG feTurbulence + feDisplacementMap.
    _renderCloudBitmap(bmpW, bmpH, cloudW, cloudH, pad, displaceScale, type) {
        // ---- Step 1: source shape canvas (soft elliptical/lumpy blob) ----
        const src = (typeof OffscreenCanvas !== 'undefined')
            ? new OffscreenCanvas(bmpW, bmpH)
            : Object.assign(document.createElement('canvas'), { width: bmpW, height: bmpH });
        const sctx = src.getContext('2d');

        // Multi-blob source: stack 2-4 overlapping radial gradients for an irregular base shape.
        // Strong inner alpha + soft falloff give us a base that, after distortion,
        // produces clearly defined cloud silhouettes with feathered edges.
        const numBlobs = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < numBlobs; i++) {
            const t = numBlobs === 1 ? 0.5 : i / (numBlobs - 1);
            // Position blobs along the cloud's width with jitter
            const cx = pad + cloudW * (0.2 + t * 0.6) + (Math.random() - 0.5) * cloudW * 0.2;
            const cy = pad + cloudH * (0.45 + (Math.random() - 0.5) * 0.25);
            const rx = cloudW * (0.22 + Math.random() * 0.18);
            const ry = cloudH * (0.55 + Math.random() * 0.3);

            const grad = sctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
            grad.addColorStop(0,    'rgba(255,255,255,0.95)');
            grad.addColorStop(0.5,  'rgba(255,255,255,0.6)');
            grad.addColorStop(1,    'rgba(255,255,255,0)');
            sctx.fillStyle = grad;
            sctx.save();
            sctx.translate(cx, cy);
            sctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
            sctx.beginPath();
            sctx.arc(0, 0, Math.max(rx, ry), 0, Math.PI * 2);
            sctx.fill();
            sctx.restore();
        }

        const srcData = sctx.getImageData(0, 0, bmpW, bmpH);
        const srcPixels = srcData.data;

        // ---- Step 2: build coherent noise field for displacement ----
        // Two channels: noiseX and noiseY, each value-noise with bilinear interp.
        const baseFreq = type === 'wispy' ? 0.025 : 0.018;
        const seedX = Math.random() * 1000;
        const seedY = Math.random() * 1000;

        // ---- Step 3: displaced output ----
        const outData = sctx.createImageData(bmpW, bmpH);
        const outPixels = outData.data;

        // Anisotropic stretch: wispy clouds get pushed mostly horizontally
        const stretchX = type === 'wispy' ? 1.6 : 1.0;
        const stretchY = type === 'wispy' ? 0.4 : (type === 'stretched' ? 0.6 : 1.0);

        for (let y = 0; y < bmpH; y++) {
            for (let x = 0; x < bmpW; x++) {
                // Two octaves of value noise gives more organic distortion
                const nx = (this._valueNoise(x * baseFreq, y * baseFreq, seedX) - 0.5) * 2
                         + (this._valueNoise(x * baseFreq * 2, y * baseFreq * 2, seedX + 100) - 0.5);
                const ny = (this._valueNoise(x * baseFreq, y * baseFreq, seedY) - 0.5) * 2
                         + (this._valueNoise(x * baseFreq * 2, y * baseFreq * 2, seedY + 100) - 0.5);

                // Sample source at displaced coordinates (bilinear-ish — just use nearest for speed)
                const sx = x + nx * displaceScale * stretchX;
                const sy = y + ny * displaceScale * stretchY;

                const xi = Math.round(sx);
                const yi = Math.round(sy);
                if (xi < 0 || xi >= bmpW || yi < 0 || yi >= bmpH) continue;

                const srcIdx = (yi * bmpW + xi) * 4;
                const dstIdx = (y * bmpW + x) * 4;
                outPixels[dstIdx]     = srcPixels[srcIdx];     // R (white)
                outPixels[dstIdx + 1] = srcPixels[srcIdx + 1]; // G
                outPixels[dstIdx + 2] = srcPixels[srcIdx + 2]; // B
                outPixels[dstIdx + 3] = srcPixels[srcIdx + 3]; // A (the only thing that matters)
            }
        }

        // Bake into an intermediate canvas
        const intermediate = (typeof OffscreenCanvas !== 'undefined')
            ? new OffscreenCanvas(bmpW, bmpH)
            : Object.assign(document.createElement('canvas'), { width: bmpW, height: bmpH });
        intermediate.getContext('2d').putImageData(outData, 0, 0);

        // Final pass: blur to soften ALL edges uniformly. Without this, displacement
        // preserves alpha gradients from the source which can read as visible "ridges".
        // Blur radius scales with cloud size for consistent look across types.
        const blurRadius = Math.round(Math.max(3, displaceScale * 0.12));
        const out = (typeof OffscreenCanvas !== 'undefined')
            ? new OffscreenCanvas(bmpW, bmpH)
            : Object.assign(document.createElement('canvas'), { width: bmpW, height: bmpH });
        const octx = out.getContext('2d');
        octx.filter = `blur(${blurRadius}px)`;
        octx.drawImage(intermediate, 0, 0);
        octx.filter = 'none';
        return out;
    }

    // 2D value noise with bilinear interpolation, [0..1] output.
    // Smooth and coherent — neighboring inputs return similar outputs (vs. random noise).
    _valueNoise(x, y, seed) {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        const xf = x - xi;
        const yf = y - yi;
        // Smoothstep for nicer interpolation than linear
        const u = xf * xf * (3 - 2 * xf);
        const v = yf * yf * (3 - 2 * yf);

        const a = this._hash2(xi,     yi,     seed);
        const b = this._hash2(xi + 1, yi,     seed);
        const c = this._hash2(xi,     yi + 1, seed);
        const d = this._hash2(xi + 1, yi + 1, seed);

        return a * (1 - u) * (1 - v)
             + b * u       * (1 - v)
             + c * (1 - u) * v
             + d * u       * v;
    }

    // Cheap deterministic 2D hash → [0..1]
    _hash2(x, y, seed) {
        let h = (x * 374761393 + y * 668265263 + seed * 982451653) | 0;
        h = (h ^ (h >>> 13)) * 1274126177 | 0;
        h = h ^ (h >>> 16);
        return ((h >>> 0) % 10000) / 10000;
    }

    // ---------- Update + Draw ----------

    update(timestamp) {
        // Periodic weather refresh
        if (this.useWeather) this.fetchWeather();

        // Compute frame delta for time-based motion (rain etc.)
        const dt = this._lastTimestamp ? Math.min(0.1, (timestamp - this._lastTimestamp) / 1000) : 0.016;
        this._lastTimestamp = timestamp;

        // Adjust cloud population if cover changed (e.g., override slider moved)
        const targetCount = Math.floor((this.getCurrentCloudCover() / 100) * 28);
        while (this.clouds.length < targetCount) this.clouds.push(this._makeCloud(true));
        while (this.clouds.length > targetCount) this.clouds.pop();

        // Update precipitation
        this._updatePrecipitation(dt);

        // Update lightning (only during thunderstorms)
        const precip = this.getCurrentPrecipitation();
        if (precip === 'thunder') {
            this._updateLightning(timestamp, dt);
        } else {
            this.lightningPhase = 0;
            this.lightningBolt = null;
        }
    }

    draw(ctx, timestamp = performance.now()) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        this._ensureGenerated(w, h);

        const hour = this.getCurrentHour();
        const nightAmt = this._nightAmount(hour);
        const precipCfg = this._precipConfig();

        // Get palette and desaturate it for rain
        let palette = this._getPalette(hour);
        if (precipCfg.desat > 0) palette = this._desaturatePalette(palette, precipCfg.desat);

        // 1. Sky gradient
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0,    this._rgb(palette.top));
        grad.addColorStop(0.55, this._rgb(palette.mid));
        grad.addColorStop(1,    this._rgb(palette.bot));
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // 2. Stars (faded by night amount AND by rain — heavy rain hides stars)
        if (nightAmt > 0.01) {
            const starAlpha = nightAmt * (1 - precipCfg.desat * 0.7);
            if (starAlpha > 0.05) this._drawStars(ctx, timestamp, starAlpha);
        }

        // 3. Sun or moon (dimmed by rain)
        const celestial = this._drawCelestial(ctx, hour, w, h, 1 - precipCfg.desat * 0.5);

        // 4. Clouds
        let occlusion = 0;
        if (this.getCurrentCloudCover() > 5) {
            const sunPos = (celestial && celestial.isSun) ? celestial : null;
            this._drawClouds(ctx, palette, nightAmt, sunPos);
            if (sunPos) occlusion = this._computeSunOcclusion(sunPos.x, sunPos.y);
        }

        // 5. Sun occlusion dimming
        if (occlusion > 0.01) {
            ctx.fillStyle = `rgba(15, 20, 35, ${occlusion * 0.55})`;
            ctx.fillRect(0, 0, w, h);
        }

        // 6. Horizon haze near sunrise/sunset
        this._drawHorizonGlow(ctx, hour, w, h);

        // 7. Rain streaks (in front of clouds, behind splashes/lightning)
        if (precipCfg.count > 0) this._drawRain(ctx, precipCfg);

        // 8. Splashes (small marks where rain hits the ground)
        if (this.splashes.length > 0) this._drawSplashes(ctx);

        // 9. Lightning flash (full-canvas wash + bolt)
        if (this.lightningPhase > 0.001) this._drawLightning(ctx, w, h);
    }

    // Reduce saturation of the sky palette by the given amount (0-1).
    // 0 = no change, 1 = fully grey.
    _desaturatePalette(palette, amt) {
        const flatten = (rgb) => {
            const grey = (rgb[0] + rgb[1] + rgb[2]) / 3;
            // Lean grey-green/blue typical of overcast rain
            const targetR = grey * 0.85;
            const targetG = grey * 0.92;
            const targetB = grey * 0.95;
            return [
                Math.round(rgb[0] + (targetR - rgb[0]) * amt),
                Math.round(rgb[1] + (targetG - rgb[1]) * amt),
                Math.round(rgb[2] + (targetB - rgb[2]) * amt),
            ];
        };
        return { top: flatten(palette.top), mid: flatten(palette.mid), bot: flatten(palette.bot) };
    }

    _drawStars(ctx, t, alpha) {
        for (const s of this.stars) {
            const tw = (Math.sin(t * 0.001 * s.speed + s.phase) + 1) * 0.5;
            const a = alpha * (0.25 + tw * 0.75);
            const size = s.bright ? s.size * 1.6 : s.size;

            if (s.bright) {
                // soft glow for the showcase stars
                const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, size * 4);
                g.addColorStop(0, `rgba(255,255,230,${a * 0.35})`);
                g.addColorStop(1, 'rgba(255,255,230,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(s.x, s.y, size * 4, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.fillStyle = `rgba(255,250,225,${a})`;
            ctx.beginPath();
            ctx.arc(s.x, s.y, size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawCelestial(ctx, hour, w, h, dim = 1) {
        const sr = this.sunrise;
        const ss = this.sunset;
        const isDay = hour >= sr - 0.3 && hour <= ss + 0.3;

        let t; // 0 to 1 across the arc
        if (isDay) {
            t = (hour - sr) / (ss - sr);
        } else {
            // Moon: ss -> 24 -> sr
            const moonStart = ss;
            const moonEnd = sr + 24;
            const moonHour = hour < sr ? hour + 24 : hour;
            t = (moonHour - moonStart) / (moonEnd - moonStart);
        }
        t = Math.max(0, Math.min(1, t));

        const x = t * w;
        const y = h * 0.55 - Math.sin(t * Math.PI) * h * 0.45;

        ctx.save();
        ctx.globalAlpha = dim;
        if (isDay) {
            this._drawSun(ctx, x, y, hour, sr, ss);
        } else {
            this._drawMoon(ctx, x, y);
        }
        ctx.restore();

        return { x, y, isSun: isDay };
    }

    // Returns 0-1 indicating how much cloud overlaps the sun position
    _computeSunOcclusion(sunX, sunY) {
        const sunRadius = 26;
        const checkRadius = sunRadius * 1.8;
        let total = 0;

        for (const c of this.clouds) {
            // Cloud's bounding box on screen
            const cx = c.x + c.bmpW / 2;
            const cy = c.y + c.bmpH / 2;
            const halfW = c.width / 2 + checkRadius;
            const halfH = c.height / 2 + checkRadius;

            const dx = Math.abs(cx - sunX);
            const dy = Math.abs(cy - sunY);
            if (dx > halfW || dy > halfH) continue;

            // Approximate occlusion from how deep the sun is inside the cloud's box,
            // scaled by cloud opacity. Soft falloff at the edges.
            const fx = 1 - dx / halfW;
            const fy = 1 - dy / halfH;
            const overlap = Math.min(fx, fy);
            total += overlap * c.opacity * 0.6;
        }

        return Math.min(1, total);
    }

    _drawSun(ctx, x, y, hour, sr, ss) {
        const r = 26;
        // Color shifts orange near horizon
        const distFromHorizon = Math.min(Math.abs(hour - sr), Math.abs(hour - ss));
        const horizonMix = Math.max(0, 1 - distFromHorizon / 2); // 1 at horizon
        const sunColor = [
            Math.round(255 - 0 * (1 - horizonMix)),
            Math.round(235 - 80 * horizonMix),
            Math.round(120 - 80 * horizonMix),
        ];

        // Outer glow
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
        g.addColorStop(0, `rgba(${sunColor[0]},${sunColor[1]},${sunColor[2]},0.45)`);
        g.addColorStop(0.5, `rgba(${sunColor[0]},${sunColor[1]},${sunColor[2]},0.12)`);
        g.addColorStop(1, `rgba(${sunColor[0]},${sunColor[1]},${sunColor[2]},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r * 5, 0, Math.PI * 2);
        ctx.fill();

        // Sun disc
        ctx.fillStyle = `rgb(${sunColor[0]},${sunColor[1]},${sunColor[2]})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawMoon(ctx, x, y) {
        const r = 20;
        // Soft glow
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
        g.addColorStop(0, 'rgba(240,240,220,0.35)');
        g.addColorStop(1, 'rgba(240,240,220,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r * 4, 0, Math.PI * 2);
        ctx.fill();

        // Moon disc
        ctx.fillStyle = '#f0eed8';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();

        // Craters
        ctx.fillStyle = 'rgba(170,165,145,0.55)';
        const craters = [[-6, -4, 3.5], [5, 6, 2.5], [7, -7, 1.8], [-4, 7, 2]];
        for (const [dx, dy, cr] of craters) {
            ctx.beginPath();
            ctx.arc(x + dx, y + dy, cr, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawClouds(ctx, palette, nightAmt, sunPos) {
        // Cloud tint: derived from bottom-of-sky tone, lightened by day, darkened at night
        const base = palette.bot;
        const lightR = Math.min(255, base[0] + 50);
        const lightG = Math.min(255, base[1] + 50);
        const lightB = Math.min(255, base[2] + 50);
        const darkR = Math.max(20, Math.round(base[0] * 0.35));
        const darkG = Math.max(20, Math.round(base[1] * 0.35));
        const darkB = Math.max(30, Math.round(base[2] * 0.45));

        const r = Math.round(lightR + (darkR - lightR) * nightAmt);
        const g = Math.round(lightG + (darkG - lightG) * nightAmt);
        const b = Math.round(lightB + (darkB - lightB) * nightAmt);

        const hlAmt = 1 - nightAmt;
        const hr = Math.min(255, r + Math.round(40 * hlAmt));
        const hg = Math.min(255, g + Math.round(40 * hlAmt));
        const hb = Math.min(255, b + Math.round(35 * hlAmt));

        // Reuse a single scratch canvas for tinting (sized up if needed)
        if (!this._scratch) {
            this._scratch = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(512, 256)
                : Object.assign(document.createElement('canvas'), { width: 512, height: 256 });
        }
        const scratch = this._scratch;
        const sctx = scratch.getContext('2d');

        for (const c of this.clouds) {
            // drift
            c.x += c.speed;
            if (this._windDirection === -1) {
                if (c.x + c.bmpW < 0) c.x = this.lastWidth;
            } else {
                if (c.x > this.lastWidth) c.x = -c.bmpW;
            }

            // Resize scratch if cloud doesn't fit
            if (scratch.width < c.bmpW || scratch.height < c.bmpH) {
                scratch.width = Math.max(scratch.width, c.bmpW);
                scratch.height = Math.max(scratch.height, c.bmpH);
            }

            // Per-cloud sun proximity (0 = far, 1 = directly over sun).
            // Used to make clouds blocking the sun look denser/darker.
            let sunProx = 0;
            if (sunPos) {
                const cx = c.x + c.bmpW / 2;
                const cy = c.y + c.bmpH / 2;
                const halfW = c.width / 2;
                const halfH = c.height / 2;
                const dx = Math.abs(cx - sunPos.x);
                const dy = Math.abs(cy - sunPos.y);
                if (dx < halfW && dy < halfH) {
                    const fx = 1 - dx / halfW;
                    const fy = 1 - dy / halfH;
                    sunProx = Math.min(fx, fy);
                }
            }

            // Clear the scratch region we're about to use
            sctx.clearRect(0, 0, c.bmpW, c.bmpH);

            // 1. Stamp the displaced cloud bitmap onto scratch
            sctx.globalCompositeOperation = 'source-over';
            sctx.drawImage(c.bitmap, 0, 0);

            // 2. Tint: the bitmap on scratch has transparent areas, so source-atop
            //    correctly clips to only the cloud silhouette. When the cloud is
            //    blocking the sun, darken the tint so the cloud reads as denser
            //    (real backlit clouds look darker in the middle, brighter at edges).
            const tintDarken = 1 - sunProx * 0.45;
            const tr = Math.round(r * tintDarken);
            const tg = Math.round(g * tintDarken);
            const tb = Math.round(b * tintDarken);
            sctx.globalCompositeOperation = 'source-atop';
            sctx.fillStyle = `rgb(${tr},${tg},${tb})`;
            sctx.fillRect(0, 0, c.bmpW, c.bmpH);

            // Highlights on top half (day only)
            if (hlAmt > 0.15 && c.type !== 'wispy') {
                const hlGrad = sctx.createLinearGradient(0, 0, 0, c.bmpH);
                hlGrad.addColorStop(0,    `rgba(${hr},${hg},${hb},${0.5 * hlAmt})`);
                hlGrad.addColorStop(0.5,  `rgba(${hr},${hg},${hb},0)`);
                hlGrad.addColorStop(1,    `rgba(${hr},${hg},${hb},0)`);
                sctx.fillStyle = hlGrad;
                sctx.fillRect(0, 0, c.bmpW, c.bmpH);
            }

            // 5. Composite the finished cloud onto the sky.
            // Boost opacity for clouds blocking the sun — they should look denser.
            ctx.save();
            const opacityBoost = 1 + sunProx * 0.5;
            ctx.globalAlpha = Math.min(1, c.opacity * opacityBoost);
            ctx.drawImage(scratch, 0, 0, c.bmpW, c.bmpH,
                          Math.round(c.x), Math.round(c.y), c.bmpW, c.bmpH);
            ctx.restore();
        }
    }

    // ---------- Rain ----------

    _updatePrecipitation(dt) {
        const cfg = this._precipConfig();
        const w = this.lastWidth;
        const h = this.lastHeight;
        if (!w || !h) return;

        // Wind-driven horizontal velocity. -ve = leftward.
        const signedWind = (this._windDirection || 1) * Math.abs(this._windMph || 0);
        const windPx = signedWind * 4;  // 100 mph wind = 400 px/s horizontal

        // Extend spawn zone upwind so drops cover the full canvas bottom edge.
        // A drop spawned at y=0 drifts (windPx * fallTime) px before hitting ground.
        // We extend the spawn band on the upwind side by that amount (capped at w)
        // so every bottom-edge x position is reachable by at least one raindrop.
        const fallTime = cfg.speed > 0 ? h / cfg.speed : 0;
        const overshoot = cfg.speed > 0 ? Math.min(Math.abs(windPx) * fallTime, w) : 0;

        // Scale count to maintain the same visible density across the wider zone
        const scaledCount = cfg.count > 0 ? Math.ceil(cfg.count * (w + overshoot) / w) : 0;

        while (this.raindrops.length < scaledCount) {
            this.raindrops.push(this._makeRaindrop(true, windPx, overshoot));
        }
        while (this.raindrops.length > scaledCount) {
            this.raindrops.pop();
        }

        // Update raindrops
        for (let i = this.raindrops.length - 1; i >= 0; i--) {
            const r = this.raindrops[i];
            r.x += windPx * dt;
            r.y += cfg.speed * dt;

            // Reached the ground line for this column?
            const groundY = this._getGroundY(r.x);
            if (r.y >= groundY) {
                if (Math.random() < cfg.splashChance) {
                    this.splashes.push({
                        x: r.x,
                        y: groundY,
                        life: 0,
                        maxLife: 0.35 + Math.random() * 0.25,
                    });
                }
                Object.assign(r, this._makeRaindrop(false, windPx, overshoot));
                continue;
            }

            // Gone past the extended zone? recycle. Upwind drops that haven't
            // entered the screen yet are NOT culled — they'll drift in naturally.
            if (r.x < -(overshoot + 20) || r.x > w + overshoot + 20) {
                Object.assign(r, this._makeRaindrop(false, windPx, overshoot));
            }
        }

        // Update splashes
        for (let i = this.splashes.length - 1; i >= 0; i--) {
            const s = this.splashes[i];
            s.life += dt;
            if (s.life >= s.maxLife) this.splashes.splice(i, 1);
        }
    }

    _makeRaindrop(randomY, windPx = 0, overshoot = 20) {
        const w = this.lastWidth;
        const h = this.lastHeight;
        // Place the extra spawn margin on the UPWIND side so drops drift into view
        const leftExtra  = windPx > 0 ? overshoot : 0;  // rightward wind: spawn further left
        const rightExtra = windPx < 0 ? overshoot : 0;  // leftward wind:  spawn further right
        return {
            x: -leftExtra + Math.random() * (w + leftExtra + rightExtra),
            y: randomY ? Math.random() * h : -20 - Math.random() * 60,
            speedJitter: 0.85 + Math.random() * 0.3,
        };
    }

    _drawRain(ctx, cfg) {
        // Streak should point in the direction the drop is moving.
        // Velocity vector: (windPx, cfg.speed). Tail extends opposite that.
        const signedWind = (this._windDirection || 1) * Math.abs(this._windMph || 0);
        const windPx = signedWind * 4;

        // Length scales with type and wind. Normalize the velocity, then multiply.
        const baseLen = cfg.length * (1 + Math.abs(this._windMph || 0) / 200);
        const vMag = Math.sqrt(windPx * windPx + cfg.speed * cfg.speed) || 1;
        const ux = windPx / vMag;
        const uy = cfg.speed / vMag;
        const tailDx = -ux * baseLen;  // tail goes opposite the velocity
        const tailDy = -uy * baseLen;

        ctx.save();
        ctx.strokeStyle = `rgba(180, 200, 230, ${cfg.alpha})`;
        ctx.lineWidth = 1;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const r of this.raindrops) {
            ctx.moveTo(r.x, r.y);
            ctx.lineTo(r.x + tailDx, r.y + tailDy);
        }
        ctx.stroke();
        ctx.restore();
    }

    _drawSplashes(ctx) {
        ctx.save();
        for (const s of this.splashes) {
            const t = s.life / s.maxLife;       // 0 -> 1 over splash lifetime
            const alpha = (1 - t) * 0.5;
            const radius = 2 + t * 4;            // ring expands

            ctx.strokeStyle = `rgba(190, 210, 235, ${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            // half-ring (top half only - splashes go up, not down through ground)
            ctx.arc(s.x, s.y, radius, Math.PI, 2 * Math.PI);
            ctx.stroke();

            // Tiny upward droplet specks
            if (t < 0.5) {
                ctx.fillStyle = `rgba(190, 210, 235, ${alpha * 1.5})`;
                ctx.fillRect(s.x - 2, s.y - 1 - t * 4, 1, 1);
                ctx.fillRect(s.x + 1, s.y - 1 - t * 5, 1, 1);
            }
        }
        ctx.restore();
    }

    // ---------- Lightning ----------

    _updateLightning(timestamp, dt) {
        // Initialize next strike time on first call
        if (this.nextLightningAt === 0) {
            this.nextLightningAt = timestamp + 3000 + Math.random() * 8000;
        }

        // Decay current flash
        if (this.lightningPhase > 0) {
            this.lightningPhase -= dt * 4;  // ~250ms full fade
            if (this.lightningPhase <= 0) {
                this.lightningPhase = 0;
                this.lightningBolt = null;
            }
        }

        // Time for a new strike?
        if (timestamp >= this.nextLightningAt) {
            this.lightningPhase = 1;
            this.lightningBolt = this._generateBolt();
            this.nextLightningAt = timestamp + 5000 + Math.random() * 25000;
        }
    }

    // Generate a jagged lightning bolt as a polyline from sky to ground
    _generateBolt() {
        const w = this.lastWidth;
        const h = this.lastHeight;
        const startX = w * (0.2 + Math.random() * 0.6);
        const startY = h * 0.05;
        const endX = startX + (Math.random() - 0.5) * w * 0.3;
        const endY = h * (0.55 + Math.random() * 0.25);

        // Build segmented path with random offsets
        const segments = 8 + Math.floor(Math.random() * 6);
        const points = [];
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const x = startX + (endX - startX) * t + (Math.random() - 0.5) * 30;
            const y = startY + (endY - startY) * t;
            points.push({ x, y });
        }

        // Random branches
        const branches = [];
        const branchCount = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < branchCount; i++) {
            const startIdx = 2 + Math.floor(Math.random() * (points.length - 4));
            const start = points[startIdx];
            const branchPoints = [start];
            const segs = 3 + Math.floor(Math.random() * 4);
            const dirX = (Math.random() - 0.5) * 60;
            const dirY = 30 + Math.random() * 60;
            for (let j = 1; j <= segs; j++) {
                const t = j / segs;
                branchPoints.push({
                    x: start.x + dirX * t + (Math.random() - 0.5) * 20,
                    y: start.y + dirY * t,
                });
            }
            branches.push(branchPoints);
        }

        return { points, branches };
    }

    _drawLightning(ctx, w, h) {
        // 1. Full-canvas flash
        ctx.fillStyle = `rgba(255, 255, 240, ${this.lightningPhase * 0.55})`;
        ctx.fillRect(0, 0, w, h);

        // 2. Bolt itself
        if (this.lightningBolt) {
            ctx.save();
            // Outer glow
            ctx.strokeStyle = `rgba(180, 200, 255, ${this.lightningPhase * 0.7})`;
            ctx.lineWidth = 6;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            const pts = this.lightningBolt.points;
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            // Branches glow
            for (const branch of this.lightningBolt.branches) {
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(branch[0].x, branch[0].y);
                for (let i = 1; i < branch.length; i++) ctx.lineTo(branch[i].x, branch[i].y);
                ctx.stroke();
            }

            // Inner core (bright white)
            ctx.strokeStyle = `rgba(255, 255, 255, ${this.lightningPhase})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            for (const branch of this.lightningBolt.branches) {
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(branch[0].x, branch[0].y);
                for (let i = 1; i < branch.length; i++) ctx.lineTo(branch[i].x, branch[i].y);
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    // ---------- Wind (called externally per round) ----------

    setWindSpeed(mph) {
        this._windMph = Math.abs(mph || 0);
        this._windDirection = (mph || 0) < 0 ? -1 : 1;

        // Update each cloud's speed.
        // Maps |mph| 0-100 to a sensible drift; preserves per-cloud variance.
        const windFactor = this._windMph / 60;
        for (const c of this.clouds) {
            if (c.baseSpeed === undefined) c.baseSpeed = c.speed;
            const magnitude = c.baseSpeed + windFactor * 0.4;
            c.speed = magnitude * this._windDirection;
        }
    }


    _drawHorizonGlow(ctx, hour, w, h) {
        const sr = this.sunrise;
        const ss = this.sunset;
        const distSr = Math.abs(hour - sr);
        const distSs = Math.abs(hour - ss);
        const dist = Math.min(distSr, distSs);
        if (dist > 1.5) return;

        const intensity = 1 - dist / 1.5;
        const isSunset = distSs < distSr;
        const color = isSunset
            ? `rgba(255, 130, 70, ${0.25 * intensity})`
            : `rgba(255, 180, 120, ${0.22 * intensity})`;

        const g = ctx.createLinearGradient(0, h * 0.5, 0, h);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, color);
        ctx.fillStyle = g;
        ctx.fillRect(0, h * 0.5, w, h * 0.5);
    }
}

// Export for both module and script-tag use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Sky;
}
