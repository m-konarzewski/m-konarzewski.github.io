+++ 
draft = false
date = 2026-09-18T11:18:41+02:00
title = "FFmpeg architecture overview"
tags = ["ffmpeg", "ffplay", "ffprobe"]
categories = ["FFmpeg"]
+++

If you've only ever invoked `ffmpeg` from a shell script, it's easy to think of it as a single monolithic binary. It isn't. **FFmpeg** is the name of a project that produces a _set of C libraries_ plus a handful of thin command-line tools built on top of them. Understanding that split matters the moment you start writing C++ against `libavcodec`/`libavformat` directly, because the library boundaries map almost exactly onto the stages of a media pipeline.

## The libraries

FFmpeg ships as roughly six shared/static libraries. Each owns one well-defined responsibility, and the CLI tools are just orchestrators that call into all of them.

| Library           | Responsibility                                                                                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **libavutil**     | Common utility code: math functions, dictionaries, pixel format/sample format definitions, memory management (`AVFrame` buffer allocation), logging, `AVRational` timebases. Every other library depends on it.                                                                                                  |
| **libavcodec**    | Encoders and decoders (codecs) — H.264, HEVC, AAC, Opus, and hundreds more. This is where `AVCodecContext`, `AVPacket`, and the encode/decode API live.                                                                                                                                                          |
| **libavformat**   | Muxers and demuxers — reading and writing _container_ formats (MP4, MKV, MPEG-TS, FLV...). This is where `AVFormatContext` and I/O abstraction (`AVIOContext`) live. Note: container ≠ codec — this library doesn't know how to decode a frame, only how to pull packets out of (or push them into) a container. |
| **libavfilter**   | Filter graphs — scaling, cropping, overlaying, format conversion, and hundreds of audio/video filters, composable into a graph.                                                                                                                                                                                  |
| **libswscale**    | Pixel format conversion and image scaling (e.g., YUV420P → RGB24). A predecessor to some of what `libavfilter` can also do, kept as a lean standalone library.                                                                                                                                                   |
| **libswresample** | The audio equivalent of `libswscale` — sample format conversion, resampling, channel layout remixing.                                                                                                                                                                                                            |

A useful mental model: **libavformat gets bytes in and out of containers, libavcodec turns those bytes into (or from) raw frames, libavutil is the shared foundation everything sits on, and libavfilter/libswscale/libswresample transform frames once you have them.**

## A few terms you'll see everywhere

A handful of terms get thrown around loosely even in FFmpeg's own docs, so it's worth pinning them down in plain language before looking at the CLI examples below.

A **container** (MP4, MKV, MPEG-TS, and so on) is a box format that describes how streams, metadata, and packets are laid out inside a file; a **codec** (H.264, AAC, and so on) is the compression scheme used for the actual audio/video data stored inside that box — the two are independent, and the same H.264 bitstream can sit inside an MP4 or an MKV without changing at all.

**Muxing** is the act of interleaving multiple encoded streams (video, audio, subtitles) into one container file, and **demuxing** is pulling them back apart — every read of a media file starts with a demux, and every write ends with a mux.

Building on that, **transmuxing** (also called "remuxing") means taking the already-encoded packets from one container and repackaging them into another container, without touching the encoded bitstream itself — no decode, no encode, just moving compressed packets around, which is why it's nearly instant and lossless.

**Transcoding**, by contrast, means fully decoding compressed frames back down to raw pixels or audio samples and then re-encoding them, usually into a different codec (or the same codec with different settings); it's far more CPU/GPU-expensive than transmuxing because it does real decode and encode work, but it's the only way to actually change codec, resolution, bitrate, or frame rate.

## The three CLI tools

On top of these libraries, the project ships three command-line programs. They're what most people mean when they say "FFmpeg," but they're consumers of the libraries, not the libraries themselves.

### `ffmpeg` — convert, transcode, mux/demux

The general-purpose pipeline tool: read input(s), optionally decode/filter/encode, write output(s).

```bash
# Remux (no re-encode) an MKV into MP4 — just changes the container
ffmpeg -i input.mkv -c copy output.mp4

# Transcode to H.264/AAC with a target video bitrate
ffmpeg -i input.mp4 -c:v libx264 -b:v 2M -c:a aac output.mp4

# Extract a 10-second clip starting at 00:01:30, scaled to 1280 width
ffmpeg -ss 00:01:30 -i input.mp4 -t 10 -vf scale=1280:-1 clip.mp4
```

### `ffplay` — play back a media file

A minimal SDL-based media player, mainly used to sanity-check output visually/aurally without opening a full video player.

```bash
# Play a file
ffplay input.mp4

# Play with a video filter applied live (e.g. preview a scale)
ffplay -vf scale=640:-1 input.mp4

# Play starting from a timestamp, useful for jumping to a suspect region
ffplay -ss 00:02:10 input.mp4
```

### `ffprobe` — inspect a media file

Reads container/stream metadata without decoding frame data — the tool you reach for before writing any code, to see what you're actually dealing with.

```bash
# Human-readable summary of streams, codecs, duration
ffprobe input.mp4

# Machine-readable JSON output, e.g. for scripting
ffprobe -v quiet -print_format json -show_format -show_streams input.mp4

# Just the video stream's resolution and frame rate
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate input.mp4
```
