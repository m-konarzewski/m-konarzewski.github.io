+++ 
draft = false
date = 2026-07-30T17:02:47+02:00
title = "The fundamentals of Videos"
tags = ["video", "video streaming", "video fundamentals", "codecs", "compression"]
categories = ["video-streaming"]
+++

Before diving into protocols, codecs, and video pipeline optimizations, it's worth stepping back and answering a question that sounds trivial but is rarely addressed head-on: **what is a video file, really?**

The question seems obvious — we all watch videos every day. But try to answer it precisely: what exactly happens between the moment a camera captures a scene and the moment you see it on your phone screen, delivered over the internet in a fraction of a second? The answer runs through several layers of abstraction, each solving a distinct engineering problem. Understanding these layers — individually and in relation to each other — is the foundation without which it's hard to meaningfully discuss streaming, compression, or image quality.

This article is deliberately free of specific technologies, libraries, or code. It's a conceptual introduction — a map of the terrain we'll later navigate in much more technical depth.

## The starting point: video is an optical illusion

Let's start with something fundamental that's easy to overlook: **video doesn't actually exist as continuous motion.** What we perceive as smooth animation is, in reality, a series of still images displayed one after another, fast enough that our visual system can't distinguish the individual frames.

This phenomenon, known as **persistence of vision** (though modern science suggests the underlying mechanism is somewhat more complex than a simple "sluggishness" of the retina), was discovered and exploited long before computers existed — the earliest optical toys using this effect, like the phenakistoscope or the zoetrope, date back to the 19th century, well before the invention of cinema.

The consequence for us is simple but fundamental: **every video file, no matter how technically sophisticated, boils down to a sequence of images plus information about how fast to display them.** Everything else — codecs, containers, streaming protocols — is engineering built around that one simple idea, all in service of one question: how do we store and transmit that sequence as efficiently as possible.

<img src="/images/frame-sequence-motion.svg" alt="A sequence of individual frames perceived as motion">

## Anatomy of a single frame

Before moving on to sequences, let's pause on a single frame, since it's the basic unit everything else is built from.

### Resolution

Resolution defines the number of pixels making up a single image, usually expressed as width × height. A resolution of 1920×1080 (commonly known as "Full HD") means each frame consists of 1920 columns and 1080 rows of pixels — over 2 million individual picture points in total.

It's worth noting that names like "4K" or "8K" don't refer directly to the number of pixels vertically (as was the case with "1080p" or "720p"), but roughly to the number of pixels horizontally — 4K is roughly 4000 pixels wide (3840, to be exact, in the UHD standard). This is a common source of confusion when comparing resolution standards.

Higher resolution means more detail, but also **significantly** more data to process — doubling the resolution in both dimensions (e.g., from Full HD to 4K) results in roughly a fourfold increase in pixel count, and therefore a fourfold increase in raw data per frame.

### Color depth and color models

Each pixel isn't a single value — it's a set of values describing its color. The most intuitive model is **RGB** — each pixel is described by three numbers: the intensity of red, green, and blue components. At the standard depth of 8 bits per channel, each of these three values falls in the range 0-255, yielding over 16 million possible colors per pixel.

In the world of video, however, a different model is very commonly used: **YCbCr** (sometimes casually, if imprecisely, called "YUV"). Instead of splitting color into red/green/blue, YCbCr splits the image into:

- **Y** — luminance, i.e., the brightness of the image (effectively a black-and-white version),
- **Cb and Cr** — two chrominance channels describing the color's deviation from gray (toward blue and toward red, respectively).

Why does this matter? Because the human eye is **far** more sensitive to changes in brightness than to changes in color. This observation from the physiology of vision opens the door to one of the oldest and most effective tricks in image compression: **chroma subsampling** — storing color information at a lower resolution than brightness information, without a noticeable loss of quality for most viewers.

Familiar-looking notations like **4:2:0** or **4:4:4** describe exactly this degree of "savings" on color relative to brightness. In the 4:2:0 format — the most common in consumer video — color information is stored at a resolution four times lower than brightness information. It's one of those things that's everywhere, yet few people know it exists until they dig a bit deeper into the topic.

<img src="/images/rgb-vs-ycbcr-subsampling.svg" alt="RGB versus YCbCr with 4:2:0 chroma subsampling">

### Frames per second

**FPS** (_frames per second_) defines how many individual images are displayed within one second. It's the second fundamental axis (alongside resolution) along which the amount of data scales.

Historically, different FPS values arose from different technical constraints and conventions:

- **24 FPS** — the film industry standard, established back in the era of analog film as a compromise between motion smoothness and film stock cost,
- **25 / 30 FPS** — television standards, derived from the alternating current frequency in a given region (50 Hz in Europe, 60 Hz in North America), hence the historical split between the PAL and NTSC standards,
- **60 FPS and higher** — increasingly common in live streaming, sports broadcasts, and gaming, where motion smoothness matters more than a "cinematic" look.

Higher FPS means smoother motion, but again — proportionally more data. Doubling the frame rate doubles the amount of raw data per second of footage.

## The problem: raw video is absurdly heavy

These three variables — resolution, color depth, and FPS — multiply together, producing numbers that grow very quickly. Let's work through a concrete example.

A single frame at Full HD resolution (1920×1080), in full RGB at 8 bits per channel (with no chroma subsampling), takes up:

```
1920 × 1080 pixels × 3 bytes (R, G, B) = 6,220,800 bytes ≈ 6 MB
```

At 30 frames per second, that's already:

```
6 MB × 30 = 180 MB per second of footage
```

One minute of such raw video comes out to over **10 gigabytes**. A feature-length film at this quality, with no compression at all, would weigh several terabytes.

For comparison: a ten-minute video in Full HD, uploaded to a popular streaming platform, typically weighs a few dozen to a few hundred megabytes. A difference on the order of 100-1000x doesn't come from nowhere — it's the work of **compression**, or more precisely, what codecs do, and they are the true hero of this whole story.

<img src="/images/raw-video-data-growth.svg" alt="Raw video data growth: from a single frame to a full movie">

It's worth remembering this order of magnitude, because it explains why the entire video industry — from Netflix to a simple video call — is built around one unrelenting trade-off: **image quality versus the amount of data to transmit and store.**

## Codecs: how to pack this data so it can actually be sent

A **codec** (short for "coder-decoder") is an algorithm that can compress raw video down to a much smaller size, and then — on the receiving end — reconstruct it into a form that can be displayed.

Names you've probably already heard, like **H.264 (also known as AVC)**, **H.265 (HEVC)**, **VP9**, and **AV1**, are exactly this — codecs. They're not file formats — they're methods of compressing moving images, meaning specific algorithms and specifications defining how a video stream is encoded and decoded.

### Lossy versus lossless compression

Before getting into specific techniques, it's worth distinguishing between two fundamentally different approaches to compression:

- **Lossless compression** — after decoding, you get back exactly the same data as before compression, down to the last bit. A familiar everyday example: ZIP files.
- **Lossy compression** — you accept some loss of information in exchange for a much better compression ratio. The decoded image isn't identical to the original, but — if the algorithm is well designed — the difference is nearly imperceptible to the human eye.

The vast majority of popular video codecs (H.264, H.265, VP9, AV1) are **lossy**. This is a deliberate choice — lossless video compression can shrink a file maybe 2-3x, while lossy compression can achieve a reduction on the order of 100-200x while maintaining quality that's practically indistinguishable from the original for most viewers. It's precisely this trade-off that makes video streaming possible at all, given today's internet bandwidth.

### Intra-frame compression

The first pillar of video compression works exactly like the compression of a single photo (e.g., in the JPEG format) — it exploits the fact that neighboring pixels in a natural image tend to be very similar to each other. The sky is blue over a large area, a wall has a uniform color, grass has a similar shade of green in many places at once.

Instead of storing each pixel's value individually, intra-frame compression algorithms divide the image into small blocks (typically 8×8 or 16×16 pixels), then apply mathematical transforms (most often the discrete cosine transform, DCT, or its more modern variants) that allow the content of such a block to be described far more compactly than listing out every pixel value individually — especially when the block is fairly uniform.

This is exactly the same kind of compression behind the JPEG format. A video frame compressed this way alone, with no reference to other frames, is called a **keyframe** or **I-frame** (from _intra_).

### Inter-frame compression — the real power of video codecs

This is where the real magic happens — the thing that sets video compression apart from compressing individual images. Since consecutive frames of a film usually differ from each other only slightly — the background stays the same, only the position of a moving object changes — instead of encoding each frame from scratch, a codec can store **only the difference** relative to a neighboring frame (or frames).

This leads to two additional frame types:

- **P-frame** (_predicted frame_) — a frame describing the difference relative to one preceding frame (a keyframe or another predicted frame).
- **B-frame** (_bidirectional frame_) — a frame describing the difference relative to frames both preceding and following it in display order. This sounds somewhat paradoxical — how can a frame reference one that hasn't "happened yet"? The answer lies in the fact that **encoding order and display order don't have to match**. A codec can encode (and transmit) frames in an order different from the one in which they'll ultimately be displayed, precisely so the decoder has both the past and the future relative to a given B-frame "on hand" before it plays it back.

The key mechanism behind inter-frame compression is **motion compensation**. Rather than simply subtracting the pixels of two consecutive frames from each other (which handles motion poorly), the algorithm tries to find where a given portion of the image moved to between frames, and store that motion as a displacement vector plus a small correction. If a ball on screen moved 10 pixels to the right, the codec can encode "the same chunk of image, shifted 10 pixels right" instead of describing every pixel of the ball at its new position from scratch. That's far cheaper in terms of the amount of data required.



### GOP — group of pictures

A sequence of frames starting with a keyframe (I-frame), followed by predicted frames (P and B), up to the next keyframe, is called a **GOP** (_Group of Pictures_). GOP length is an important configuration parameter in video encoding — a longer GOP (more predicted frames between consecutive keyframes) usually means better compression, but also less flexibility: if you want to seek to a specific moment in a video, the decoder has to find the nearest preceding keyframe and decode forward from it to reconstruct the requested frame.

This, incidentally, explains a phenomenon you've probably seen before — when, on a weak internet connection, the image "falls apart" into characteristic blocks and stays that way for a moment. This happens when the decoder receives corrupted or incomplete data for a keyframe (or drops a packet containing a predicted frame) — the error "spreads" across subsequent predicted frames, since each one builds on the previous one, until the next valid keyframe arrives and "resets" the image.

## Containers: the box everything travels in

This is where a common misunderstanding shows up, one worth clearing up once and for all: people conflate **codec** with **file format**. Separating these two concepts is one of those things worth understanding thoroughly once, because it comes up practically everywhere you touch the subject of video.

A **container** is a file format that packages together:

- one or more video streams (each compressed with some codec, e.g., H.264),
- one or more audio streams (compressed with a separate audio codec, e.g., AAC or Opus — video and audio codecs are entirely separate worlds, governed by different compression rules),
- subtitles (sometimes as a separate text stream, sometimes as graphics overlaid on the image),
- chapters, timestamps, metadata (title, author, copyright information),
- sometimes additional language tracks for audio or subtitles.

The process of combining all these streams into a single file is called **multiplexing** (_muxing_), and the reverse process — extracting individual streams from a file — is called **demultiplexing** (_demuxing_).

The most popular containers, which you've probably already heard of by name, are **MP4**, **MKV (Matroska)**, **WebM**, **MOV**, and **AVI**. The key thing to remember: **an `.mp4` file by itself doesn't tell you which codec was used to compress the video inside.** It's just an "envelope" — in theory, the same MP4 container could hold video encoded with H.264 or H.265, depending on what was muxed into it.

A good analogy that's easy to remember: **a container is a shipping box, and a codec is the way the contents inside were packed to take up less space.** You can have an identical box with completely different contents inside — and conversely, the same contents (the same codec) can be packed into different kinds of "boxes."

This distinction also explains a frustrating but common experience: you have an `.mkv` file that plays perfectly on one device and won't open at all on another, or shows a black screen with audio only. The culprit usually isn't the container itself (MKV is a very flexible format), but the video or audio codec inside it, which the given device simply can't decode — it doesn't have the appropriate decoder implemented.

### Why were these two layers separated in the first place?

This separation isn't accidental or purely academic — it has a very concrete engineering rationale. If file format and compression method were inseparably fused together, every new, better codec would require designing an entirely new file format from scratch, complete with support for subtitles, multiple audio tracks, metadata, chapters, and so on. Thanks to this separation, the MP4 container has been able to "host" successive generations of video codecs throughout its history, without needing to invent a new file format every time a more efficient way of compressing images came along.

## Bitrate — how much data is actually flowing per second

The last key concept that ties everything above into a practical whole is **bitrate** — the amount of data per unit of time in the footage, usually expressed in kilobits or megabits per second (kb/s, Mb/s).

Higher bitrate usually means better image quality (less "visible" compression, fewer artifacts), but also a larger file size and greater bandwidth requirements to transmit the material without interruption.

### Constant versus variable bitrate

Video encoding can be configured in two fundamentally different ways:

- **Constant Bitrate (CBR)** — the codec tries to maintain a roughly uniform amount of data per second throughout the entire piece of footage, regardless of how complex a given scene is. This approach is predictable (file size and required bandwidth are easy to estimate), but suboptimal in terms of quality — a static scene with a uniform background gets the same "data budget" as a scene full of fast motion and fine detail, which is far harder to compress without losing quality.

- **Variable Bitrate (VBR)** — the codec dynamically allocates more data to complex scenes (lots of motion, lots of detail) and less to simple ones (a static shot, uniform colors). This approach generally gives a better quality-to-file-size ratio, but the final size is less predictable, and the instantaneous bitrate can fluctuate significantly during playback.

This distinction has direct practical relevance for streaming — an internet connection has some maximum available bandwidth at any given moment. If a stream's instantaneous bitrate (especially with VBR, during a demanding scene) exceeds what the connection can carry, the result is buffering and stuttering playback — a phenomenon every one of us knows firsthand.

### Resolution, bitrate, and quality — a triangle of trade-offs

These three variables — resolution, bitrate, and perceived image quality — are tightly interconnected, and it's practically impossible to optimize all three at once. Footage at high resolution but low bitrate will show visible compression artifacts (the characteristic "blockiness," blurring in areas of heavy motion, loss of detail). The same footage at lower resolution but the same bitrate can look considerably cleaner — fewer pixels means less data is needed to describe each frame "well."

This trade-off is exactly what produces a phenomenon you experience daily when using streaming services: when your internet connection temporarily weakens, the player doesn't try to preserve resolution at all costs (which would mean constant buffering) — instead, it automatically lowers the resolution to fit within the available bandwidth at an acceptable bitrate. This phenomenon has a name and an entire body of engineering behind it — it's called **Adaptive Bitrate Streaming (ABR)**, and it's one of the cornerstones of modern video streaming. But that's a topic that deserves its own, dedicated article.

## Why all of this matters

This might read as a fairly academic discussion of pixels, transforms, and file formats. But each of these concepts has direct, practical consequences you run into — consciously or not — every time you watch anything online:

- When Netflix asks whether you'd prefer to watch in "Auto," "720p," or "4K," you're effectively choosing a point on the resolution-bitrate-quality trade-off triangle.
- When a video call suddenly turns "blocky" and blurry, you're watching, live, the effect of a lost predicted frame within a GOP, with no fast retransmission of the missing data.
- When you export a video from an editing app and choose between MP4 and MOV, you're choosing a container — but how "heavy" that file ends up being depends far more on the chosen codec and its settings than on the wrapper format itself.
- When you hear about a new codec like AV1 being "better" than H.264, what that really means is that, at the same image quality, it can achieve a significantly lower bitrate — meaning a smaller file or lower bandwidth requirements, usually at the cost of greater computational complexity for both encoding and decoding.

## Summary

Let's pull it all together:

1. **Video is a sequence of still frames**, displayed fast enough that the human visual system perceives it as smooth motion. This is the only truly fundamental fact from which everything else follows.

2. **A single frame** is an image described by resolution (pixel count), color depth (the number of bits describing each pixel's color), and color model (e.g., RGB or YCbCr, the latter enabling data savings through chroma subsampling).

3. **Raw video is enormous** — on the order of hundreds of megabytes per second of footage at Full HD resolution — which makes directly transmitting or storing it practically infeasible.

4. **Codecs** (H.264, H.265, VP9, AV1) solve this problem through lossy compression, exploiting pixel similarity within a single frame (intra-frame compression, as in JPEG) and — far more powerfully — similarity between consecutive frames (inter-frame compression, based on motion compensation), giving rise to keyframes (I-frames) and predicted frames (P-frames, B-frames) organized into GOPs.

5. **A container** (MP4, MKV, WebM) is an entirely separate layer — a file format that packages video, audio, subtitle streams, and metadata together, regardless of the specific codec used to compress them. This separation is what allows file formats to outlive successive generations of codecs.

6. **Bitrate** defines the amount of data per unit of time and is the key practical parameter in streaming — it has to fit within the available, often fluctuating, bandwidth of the network connection, which directly leads to mechanisms like adaptive bitrate streaming.

With these fundamentals in place, we can move on — to what happens when this data needs to be delivered to a viewer **in real time**, over a network with uncertain and variable bandwidth, while maintaining low latency and uninterrupted playback. That's the actual subject of video streaming — and the topic of the next article.
