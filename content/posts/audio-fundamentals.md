+++ 
draft = false
date = 2026-08-28T10:31:50+02:00
title = "Audio fundamentals & A/V Sync"
tags = ["Audio", "Sync", "PTS", "DTS"]
categories = ["Video Streaming"]
+++

The previous article deliberately left audio out of the picture entirely, focusing on what a video frame _is_ — resolution, color, compression, containers, bitrate. That silence wasn't an oversight. Audio deserves the same ground-up treatment video got, and more importantly, audio and video are not two independent tracks that happen to play at the same time — they're two entirely different signals, sampled at entirely different rates, compressed by entirely different algorithms, that a player has to keep glued together in real time. Understanding _why_ that gluing is hard — and why it sometimes visibly fails — requires understanding both halves properly first.

This article is, like its predecessor, deliberately free of code. It's a conceptual map: what digital audio actually is, how it's compressed, and then — the part that actually motivated writing it — why audio and video drift apart, and what a player has to do, continuously, to stop that from happening.

## Part 1: What digital audio actually is

### Sound as a continuous signal

Sound, physically, is a continuous pressure wave — air molecules compressing and rarefying over time, picked up by a microphone as a continuously varying voltage. A computer cannot store a continuous signal; it can only store numbers, at discrete points. Turning the first into the second is the entire subject of digital audio, and it happens through two independent decisions: how _often_ to measure the signal, and how _precisely_ to record each measurement.

### Sampling rate

**Sampling rate** (or sample rate) is how many times per second the continuous waveform is measured, expressed in Hertz. Common values you'll recognize immediately:

- **44,100 Hz** (44.1 kHz) — the CD-audio standard, chosen for reasons rooted in 1970s video-recorder engineering as much as audio theory
- **48,000 Hz** (48 kHz) — the standard for video and broadcast production; almost every video file you'll ever touch professionally uses 48 kHz audio, not 44.1
- **96 kHz / 192 kHz** — high-resolution audio production formats, rarely needed for delivery

The choice of sample rate is governed by the **Nyquist–Shannon sampling theorem**: to faithfully reconstruct a signal containing frequencies up to _f_, you must sample at a rate of at least _2f_. Human hearing tops out at roughly 20 kHz, which is exactly why 44.1 kHz and 48 kHz cluster just above 40 kHz — they're the minimum rates that comfortably capture the full range of audible frequency content, with a bit of headroom for the imperfect analog filters that have to remove anything above that limit before sampling (a step called anti-aliasing filtering — without it, frequencies above the Nyquist limit fold back down into the audible range as audible distortion, a phenomenon called aliasing).

This is a direct structural parallel to resolution in video: just as more pixels capture more spatial detail, a higher sample rate captures more of the frequency spectrum. And just as 4K isn't "better" than 1080p if the source material and viewing conditions don't warrant it, 96 kHz audio is rarely audibly better than 48 kHz for playback — it mostly matters during production, where extra headroom helps downstream processing (pitch-shifting, time-stretching, extreme EQ) avoid compounding artifacts.

### Bit depth

Where sample rate answers "how often," **bit depth** answers "how precisely." Each individual sample — each single measurement of the waveform's amplitude at one instant — is stored as a number with a fixed number of bits, and that number of bits determines how many distinct amplitude levels can be represented.

- **16-bit** — the CD standard; 65,536 possible amplitude levels, giving a theoretical dynamic range of about 96 dB
- **24-bit** — the professional production and broadcast standard; roughly 16.7 million levels, ~144 dB of theoretical dynamic range
- **32-bit float** — increasingly common in production, where the floating-point representation makes it nearly impossible to "clip" (hard-cap) a signal during intermediate processing stages, at the cost of no additional _practical_ dynamic range for final playback

This is the direct audio analogue of color depth in video: just as 8 bits per RGB channel determines how many distinct shades of red, green, and blue a pixel can express, bit depth determines how many distinct loudness levels a sample can express. Too few bits in either domain produces the same category of artifact — visible banding in gradients for video, audible "quantization noise" (a harsh, gritty texture, especially noticeable in quiet passages) for audio.

### Channels

The final axis is the number of independent audio streams captured or delivered simultaneously — **mono** (1 channel), **stereo** (2 channels, the near-universal default for consumer delivery), and multichannel configurations like **5.1** (6 channels: front-left, front-right, center, subwoofer/LFE, rear-left, rear-right) or **7.1**, used for surround-sound cinema and home theater delivery.

### Putting the three axes together: raw audio data rate

Just as the video article worked through a concrete raw-data example, it's worth doing the same here, because the resulting numbers explain a lot about why audio compression exists — and why it's a much smaller problem than video compression.

Uncompressed **PCM** (Pulse-Code Modulation — the raw, uncompressed representation, directly analogous to a raw bitmap for video) at CD quality:

```
44,100 samples/sec × 16 bits/sample × 2 channels
= 44,100 × 2 bytes × 2 channels
= 176,400 bytes/sec ≈ 172 KB/sec ≈ 1.4 Mb/sec
```

Compare that to the raw video number from the previous article — **180 MB/sec** for uncompressed Full HD at 30 fps. Raw audio is roughly **1,000× smaller** than raw video, per second of footage. This single fact explains a lot of what follows: audio compression matters, and audio sync matters enormously, but audio _bitrate budgeting_ is a much smaller concern than video bitrate budgeting in almost every practical streaming scenario. A typical streaming audio track runs somewhere between 96 kb/s and 320 kb/s; a typical streaming video track for the same content runs anywhere from 1 Mb/s to 15+ Mb/s. Audio is, bitrate-wise, a rounding error next to video — which is exactly why encoders and players alike are willing to spend disproportionate effort keeping audio _quality_ high and audio _timing_ precise, since there's essentially no bitrate cost to doing so.

## Part 2: Compressing audio

### Why audio compression is a different problem than video compression

Video compression, as covered previously, leans heavily on _spatial_ redundancy (neighboring pixels look similar) and _temporal_ redundancy (neighboring frames look similar). Audio has no spatial dimension, and while it does have temporal redundancy (a sustained note's waveform repeats itself many times per second), that redundancy is far more effectively addressed by an entirely different lever: exploiting the limits of human hearing itself, a field called **psychoacoustics**.

### Psychoacoustic compression

The central psychoacoustic phenomenon audio codecs exploit is **auditory masking**: a loud sound at one frequency makes quieter sounds at nearby frequencies, or occurring immediately before/after it, effectively inaudible to a human listener — even though both are physically present in the signal. A loud cymbal crash masks a much quieter sound occurring in the same instant; a loud tone at 1 kHz raises the threshold of audibility for tones at 900 Hz and 1.1 kHz for a short window of time.

Lossy audio codecs work by transforming the signal into the frequency domain (via something like a Modified Discrete Cosine Transform — a close relative of the DCT used in JPEG and video intra-frame compression), then allocating bits unevenly across frequency bands: bands that psychoacoustic modeling predicts will be masked (inaudible in context) get few or zero bits; bands the ear will actually notice get proportionally more. This is conceptually the audio equivalent of chroma subsampling from the video article — both techniques throw away information the underlying algorithm has good scientific reason to believe you won't perceive, rather than information that's "unimportant" in some absolute sense.

### Lossless vs. lossy — same trade-off, different numbers

The lossless/lossy distinction from the video article applies identically here:

- **Lossless audio codecs** — **FLAC**, **ALAC** (Apple Lossless) — reconstruct the exact original PCM data, bit for bit, achieving roughly 2:1 to 3:1 compression by exploiting predictable, purely mathematical redundancy (similar in spirit to how ZIP works, though tuned for waveform data specifically).
- **Lossy audio codecs** — **AAC**, **MP3**, **Opus**, **Vorbis** — discard psychoacoustically "unimportant" information, achieving far more dramatic reduction: a 1.4 Mb/s CD-quality PCM stream compresses down to a perceptually transparent 128–256 kb/s AAC or Opus stream, a reduction on the order of 6–10×, with most listeners unable to reliably distinguish the compressed version from the original in a blind test at those bitrates.

Two codecs are worth calling out specifically, since they dominate the video-streaming context this blog cares about:

- **AAC (Advanced Audio Coding)** is the near-universal default for video delivery — it's what sits inside the vast majority of MP4 files on the internet, standardized alongside H.264/H.265 and broadly hardware-decodable on essentially every consumer device.
- **Opus** is the modern choice for real-time, low-latency scenarios — video calls, WebRTC, live streaming — because it was explicitly designed for very low algorithmic delay (as low as 5 ms, versus AAC's typical 20–100+ ms), a property that matters enormously for the sync discussion below.

### Audio and the container, revisited

The previous article's core distinction — codec vs. container — extends directly: an MP4 file might hold H.264 video and AAC audio, or H.265 video and Opus audio, or any other combination the container format permits. The audio and video streams are muxed together into the same container file, but they remain, all the way through decoding, **two entirely separate compressed streams with two entirely separate decoders**. This separateness is exactly the root of the sync problem — nothing in the container format _automatically_ keeps them aligned; alignment has to be actively reconstructed by the player, using metadata the container carries specifically for that purpose.

## Part 3: Why audio and video need to be actively kept in sync

This is where the two halves of this article's title actually connect. If audio and video were sampled at the same rate, packaged in identically-sized chunks, and decoded at identical speed, sync would be a non-issue — you'd just play both streams forward at the same rate and they'd stay aligned by construction. None of those things are true.

### Different clocks, different units

Video's fundamental time unit is the **frame** — a fixed, whole-number quantity per second (24, 30, 60...). Audio's fundamental unit is the **sample** — tens of thousands per second — but audio codecs don't operate on individual samples; they operate on fixed-size **audio frames** (not to be confused with video frames), typically 1024 or 960 samples per audio frame depending on the codec. At 48 kHz, a 1024-sample AAC frame represents about 21.3 milliseconds of audio; an Opus frame is commonly configured for exactly 20 ms. Neither of these numbers divides evenly into a video frame's duration (33.3 ms at 30 fps, 16.7 ms at 60 fps) — audio frames and video frames simply don't line up on a shared grid. There is no natural "audio frame N corresponds to video frame N" relationship at all; that correspondence has to be reconstructed through timestamps, not assumed from position.

### PTS and DTS

This is the mechanism containers and codecs use to reconstruct that correspondence, and it's worth being precise about it because the two timestamp types solve genuinely different problems:

- **PTS (Presentation Timestamp)** — when this frame (audio or video) should actually be shown or played to the viewer.
- **DTS (Decoding Timestamp)** — when this frame needs to be handed to the decoder, which is not necessarily the same moment.

For audio, PTS and DTS are almost always identical — audio frames are typically decoded in the same order they're presented. For video, they can diverge significantly, and the reason connects directly back to the previous article: **B-frames** reference frames that come _after_ them in presentation order, which means the encoder has to transmit (and the decoder has to decode) frames in a different order than they'll be displayed. A GOP with B-frames gets encoded and decoded out of display order specifically so the decoder has both the "past" and "future" reference frames available before it needs to reconstruct a B-frame — DTS reflects that reordered decode sequence, while PTS always reflects the true, linear display order regardless of how scrambled the decode order is.

Every frame — audio or video — carries its own PTS, expressed in a **timebase**: a rational fraction (e.g., 1/90000 for many MPEG-TS streams, or something tied to the sample rate for audio) that converts an integer "tick count" into real wall-clock seconds. A player's entire sync mechanism is built on comparing PTS values across the two streams, converted into a common timebase, against some notion of "what time is it right now, in playback terms."

### So why does it actually drift?

If every frame carries an accurate PTS, why is sync a continuous, active problem rather than a solved one? Because the PTS values are only ever _targets_ — where a frame is supposed to land — and several independent forces continuously push the actual playback away from those targets:

1. **Independent, imperfect hardware clocks.** The audio output device and the video output device are frequently driven by physically separate clock circuits (a sound card's clock and a GPU's/display's refresh clock are not, in general, the same crystal). Even nominally identical clock rates drift relative to each other over time — a phenomenon called **clock drift** — by a small fraction of a percent, which sounds negligible until you realize a drift of just 0.1% accumulates to a full second of misalignment after roughly 17 minutes of playback.

2. **Decoder buffering asymmetry.** Audio and video frames don't take equally long to decode, and they're rarely decoded in lockstep. A complex video frame full of motion-compensated macroblocks can take meaningfully longer to decode than the audio frame nominally "next to it," especially without hardware acceleration — and that decode-time asymmetry, if not compensated for, directly translates into presentation-time drift.

3. **Network jitter, in a streaming context specifically.** Audio and video are frequently delivered as separate elementary streams, sometimes over separate connections or at least separate buffer paths, and network delivery is never perfectly smooth. A momentary stall that affects the video buffer more than the audio buffer (or vice versa) — very common, since video packets are typically much larger than audio packets for the same time span — introduces a timing gap that has nothing to do with either stream's own internal timing and everything to do with the network path each traveled.

4. **Variable frame rate and dropped/duplicated frames.** Live capture sources (webcams, screen recorders, live encoders under CPU pressure) don't always deliver a perfectly constant frame rate. When video frames are occasionally dropped or duplicated to cope with this, the _audio_ stream — which has no equivalent "video frame" concept to drop — keeps flowing at its own steady rate. If the player doesn't compensate, video and audio slip against each other exactly in proportion to however many frames were dropped or duplicated.

5. **Resampling and format conversion.** Whenever audio has to be resampled (44.1 kHz source into a 48 kHz output pipeline, for instance) or a video stream's frame rate has to be converted (23.976 fps film content played on a 60 Hz-native display pipeline — the classic 3:2 pulldown problem), each conversion step introduces its own small, compounding rounding error in the timing relationship if not handled with care.

None of these five causes is exotic — they're all present, to some degree, in essentially every real playback pipeline. That's why A/V sync isn't a "handle it once at encode time and forget about it" problem: it's a continuous correction process that has to run for the entire duration of playback.

## Part 4: How players actually keep things in sync

### Choosing a master clock

The foundational design decision in any playback pipeline is: **which stream gets to define "real time," and which stream(s) get adjusted to match it?** This is called choosing the **master clock**, and there are three conventional choices:

- **Audio master (the most common choice)** — the audio clock drives playback, and video frames are shown early, shown late, dropped, or duplicated to track it. This is the dominant approach for one very practical reason: **the human ear is far more sensitive to audio glitches than the eye is to video glitches.** A dropped or repeated video frame, within reason, is barely noticeable; a skipped or stretched chunk of audio produces an audible click, pop, or pitch warble that's immediately and unpleasantly obvious. Since audio playback devices also typically run on a fixed hardware clock that can't easily be sped up or slowed down without audible artifacts, it makes sense to treat that clock as the anchor and bend the more forgiving stream — video — around it.
- **Video master** — the video clock drives playback, and audio is resampled or has samples inserted/dropped to track it. Less common for general playback, but sometimes used when video timing fidelity matters more than perfect audio (certain broadcast and professional-monitoring contexts).
- **External/system master** — neither stream is authoritative; both audio and video are synced against an independent wall-clock reference. This is the standard approach in **live streaming and video conferencing**, where audio and video frequently arrive via genuinely separate network paths with independent, unpredictable jitter, and pinning sync to either stream's _own_ delivery timing would just import that stream's instability into the other one.

### What the player actually does, moment to moment

With a master clock chosen, the player's ongoing job for the "slave" stream(s) is to continuously compare that stream's next frame's PTS against the master clock's current position, and correct for the difference:

- **If a video frame's PTS is slightly behind the audio clock** (video is lagging), the player can drop it entirely rather than display a stale frame — better to skip one frame than to visibly fall further behind.
- **If a video frame's PTS is slightly ahead** (video is running fast), the player holds it — delays presentation — until the audio clock catches up to that PTS.
- **For larger, sudden discrepancies** — the kind that show up after a network stall or seek operation — many players perform a harder correction: a brief audio fade-out/fade-in around a discontinuity, or an explicit resync where the video decoder is told to skip forward to the frame matching the audio clock's current position, discarding everything in between.
- **On the audio side specifically**, when audio itself needs adjusting relative to an external or video master, players use techniques like sample insertion/deletion (adding or removing occasional individual samples, ideally at points in the waveform where it's least perceptible — near zero-crossings) or fine-grained resampling, rather than anything as crude as skipping whole audio frames, precisely because the ear catches audio discontinuities that the eye would never catch in an equivalent video frame.

### Sync thresholds in practice

Human perceptual tolerance for A/V misalignment isn't symmetric, and this shapes how aggressively players correct drift. Research into perceptible lip-sync error generally finds:

- Audio **leading** video (sound before the matching lip movement) becomes noticeable at roughly **+45 ms**.
- Audio **lagging** video (sound after the matching lip movement) is tolerated up to roughly **-125 ms** before most viewers notice — we're considerably more forgiving of delayed audio than early audio, likely because it mirrors the real-world physics of sound traveling more slowly than light over distance, something the brain is already used to compensating for.

Broadcast and streaming standards typically target keeping drift within roughly ±20–40 ms specifically to stay comfortably inside that asymmetric tolerance window with margin to spare — well before it reaches the range where a viewer would consciously register "the lips don't quite match the words."

## Part 5: Where this actually shows up

Tying this back to the practical, everyday manifestations this series keeps returning to:

- **A video call where the other person's lips lag their voice** is a live demonstration of an external-master sync system falling behind — usually because video frames, being larger, are queuing up behind network jitter more than the smaller audio packets are.
- **A downloaded file that's perfectly in sync at the start but visibly drifts by the end** is almost always clock drift (cause #1 above) going uncorrected — a symptom of a player, or more often a _badly transcoded file_, that isn't actively resyncing against timestamps throughout playback, just trusting the two streams to stay aligned on their own.
- **A brief audio "hiccup" or pitch warble during a live stream, with video continuing smoothly**, is frequently the audible signature of an active sample-insertion/deletion correction — the player quietly stretching or compressing a few milliseconds of audio to pull the master clock back into alignment, small enough to be a minor annoyance rather than the alternative (letting drift accumulate unchecked).
- **A video that briefly stutters — repeats a frame — right after a network hiccup**, without any accompanying audio glitch, is usually the video-frame-drop/duplicate mechanism doing exactly its job: sacrificing a video frame or two, silently, specifically so the audio never has to be touched.

## Summary

1. **Digital audio is defined by the same kind of triad video is** — sample rate (how often), bit depth (how precisely), and channel count (how many simultaneous streams) — and the resulting raw data rate is roughly **1,000× smaller** than raw video's, which is why audio bitrate is rarely the bottleneck it is for video.

2. **Audio compression leans on psychoacoustics rather than spatial/temporal redundancy** — auditory masking lets lossy codecs like AAC and Opus discard content the ear won't perceive in context, achieving transparent quality at a fraction of PCM's raw size, while lossless codecs like FLAC preserve every bit at a much more modest compression ratio.

3. **Audio and video are two independently compressed, independently timestamped streams inside one container**, muxed together but never automatically aligned — every frame of each carries a **PTS** (when to show it) and, for video specifically, often a distinct **DTS** (when to decode it), a distinction that exists because of B-frame reordering.

4. **Drift happens continuously**, driven by independent hardware clocks running at slightly different real rates, asymmetric decode times, network jitter that doesn't affect both streams equally, dropped/duplicated frames, and resampling rounding error — none of these causes is rare, which is why sync correction has to run for the entire duration of playback, not just once at the start.

5. **Players pick a master clock — almost always audio, because the ear is far less forgiving of glitches than the eye** — and continuously correct the other stream against it: dropping or holding video frames, and finely resampling or inserting/removing individual audio samples, guided by perceptual research showing viewers tolerate lagging audio (~125 ms) far better than leading audio (~45 ms).
