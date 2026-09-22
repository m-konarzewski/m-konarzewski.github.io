+++ 
draft = false
date = 2026-09-21T12:16:12+02:00
title = "Lesson 2 - Reading file metadata"
tags = ["avformat_open_input", "avformat_find_stream_info", "metadata"]
categories = ["FFmpeg"]
+++

This is the first post where we actually touch the FFmpeg C API from C++. The scope is deliberately narrow: open a media file, read its container-level and per-stream metadata, and print it out — essentially reimplementing a slice of what `ffprobe` does. No decoding, no frames, no packets even. Just opening the container and asking it what's inside.

Everything here revolves around one struct: `AVFormatContext`. It represents an open container — the demuxer's view of a file — and it's the entry point for every other libavformat operation you'll do in this series. We'll build the program up piece by piece, then show the full listing at the end.

## Includes and setup

```cpp
extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/pixdesc.h>
#include <libavutil/samplefmt.h>
}

#include <format>
#include <iostream>
```

FFmpeg's headers are C headers, so when including them from a C++ translation unit they need to be wrapped in `extern "C"` — otherwise the C++ compiler name-mangles the declarations and the linker can't find the actual C symbols in `libavformat.so`. `libavformat/avformat.h` is the core include for this post, but it doesn't transitively pull in everything we use: `av_get_pix_fmt_name` is declared in `libavutil/pixdesc.h`, and `av_get_sample_fmt_name` in `libavutil/samplefmt.h`, so both need including explicitly — a common trap when working against this API, since it's easy to assume `avformat.h` alone gets you the whole surface of libavutil it depends on. On the C++ side, `std::format` (C++20, refined further in C++23) gives us positional, type-safe formatting without `iostream`'s manipulator verbosity, and `std::cout` handles the actual output.

## `avformat_open_input`

```cpp
AVFormatContext* fmt_ctx = nullptr;

int ret = avformat_open_input(&fmt_ctx, input_path, nullptr, nullptr);
if (ret < 0) {
    char err_buf[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(ret, err_buf, sizeof(err_buf));
    std::cerr << std::format("avformat_open_input failed: {}\n", err_buf);
    return 1;
}
```

This is the only function here that touches the filesystem directly. Passed a pointer-to-pointer, a path, and two optional arguments we don't need yet (an explicit input format and format options — both `nullptr` means "figure it out yourself"), it _probes_ the file to determine the container format rather than trusting the file extension, allocates an `AVFormatContext`, and reads just enough of the header to know the container's own metadata. For many formats, though, it doesn't yet know everything about each individual stream — that's the next call's job.

Almost every libavformat/libavcodec function returns an `int` where negative means "FFmpeg error code," not an exception or an `errno`. `av_strerror` turns that code into a human-readable string — worth wrapping in a small helper, since you'll write this same pattern constantly throughout the series. Note that `av_strerror` still fills a C-style `char[]` buffer; `std::format` happily accepts that as a `{}` argument (it decays to `const char*`), so there's no need for an intermediate `std::string` just to print it.

## `avformat_find_stream_info`

```cpp
ret = avformat_find_stream_info(fmt_ctx, nullptr);
if (ret < 0) {
    char err_buf[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(ret, err_buf, sizeof(err_buf));
    std::cerr << std::format("avformat_find_stream_info failed: {}\n", err_buf);
    avformat_close_input(&fmt_ctx);
    return 1;
}
```

`avformat_find_stream_info` exists because a container header alone often doesn't tell you enough to actually decode a stream. Some formats are self-describing enough (a well-formed MP4's `moov` atom, for example, carries most of what you need), but plenty of others — raw MPEG-TS being the classic case — only guarantee you the stream _count_ and rough codec type from the header, with details like exact frame rate, sample rate, or codec extradata only discoverable by reading actual packets.

Under the hood, this function does real work: it reads forward through the file (or the live stream, if that's what you opened), buffering up to `fmt_ctx->probesize` bytes or `fmt_ctx->max_analyze_duration` of timestamped data — both tunable via `AVFormatContext` fields _before_ calling this function, if the defaults are too aggressive or too slow for your use case. For at least one packet per stream, it goes further than just reading: it opens a throwaway decoder instance and decodes just enough frames to populate `AVCodecParameters` fields the header didn't provide, then discards that decoder — the frames themselves aren't returned to you, only the parameters they revealed. That's the reason it's a probe with real decode cost, not a header parse, and why the function returns `AVFormatContext` already populated with `nb_streams` fully described `AVStream`/`AVCodecParameters` pairs, ready for the `avcodec_open2` calls you'll write in a later post.

The practical consequence is that this is the call most likely to fail or stall — on a truncated file it can hit EOF mid-probe, and on a live network source (an RTSP camera, say) it will block until it either gathers enough data or times out, which is exactly the kind of place you want explicit error handling rather than assuming success. And because `avformat_open_input` already succeeded by the time we get here, we own an `AVFormatContext` that must be freed on any subsequent failure path too — hence the explicit `avformat_close_input` call before returning on error, rather than leaking it.

## Container-level metadata

```cpp
std::cout << std::format("Input: {}\n", input_path);
std::cout << std::format("Format: {} ({})\n", fmt_ctx->iformat->name, fmt_ctx->iformat->long_name);

if (fmt_ctx->duration != AV_NOPTS_VALUE) {
    double duration_sec = static_cast<double>(fmt_ctx->duration) / AV_TIME_BASE;
    std::cout << std::format("Duration: {:.2f} s\n", duration_sec);
} else {
    std::cout << "Duration: unknown\n";
}

if (fmt_ctx->bit_rate > 0) {
    std::cout << std::format("Overall bitrate: {} kb/s\n", fmt_ctx->bit_rate / 1000);
}

std::cout << std::format("Streams: {}\n\n", fmt_ctx->nb_streams);
```

With both calls above successful, `fmt_ctx` is fully populated and everything here is just reading fields off it — no more library calls. `iformat` points at the detected input format's descriptor, which is where the short name (`"mov,mp4,m4a,3gp,3g2,mj2"` for an MP4, for example) and long name come from. `duration` is checked against the sentinel `AV_NOPTS_VALUE` because not every format can report one (a live stream has no fixed duration); when it is known, it's stored in `AV_TIME_BASE` units — a fixed internal timebase of microseconds — which is why we divide by `AV_TIME_BASE` rather than treating it as seconds directly. This is a recurring pattern worth internalizing now: per-stream timestamps later in the series use a _different_, stream-specific timebase instead.

`bit_rate` is the container's own estimate of the overall bitrate across all streams combined, in bits per second — FFmpeg's internal unit throughout the API — which is why it's divided by 1,000 before printing, to get the more human-readable kb/s rather than a six- or seven-digit raw bits-per-second figure. It's worth treating as an estimate rather than ground truth: for some containers it's read directly from a header field, but for others (certain MPEG-TS streams again) it's only available once `avformat_find_stream_info` has probed enough of the file to compute it, and it can still be `0` or absent if the source is a live stream with no fixed rate.

`nb_streams` is simply the count of elementary streams the demuxer found inside the container — one entry per video, audio, or subtitle track, each of which gets its own `AVStream` in the array we loop over next. A typical MP4 has two: one video, one audio; a multi-language broadcast stream might have a dozen or more once you count multiple audio tracks and subtitle tracks.

Note `{:.2f}` in the duration line above — `std::format` uses `printf`-style precision specifiers inside the braces, so the fixed-point formatting reads almost identically to the C version, just without a separate conversion specifier character.

## Per-stream metadata

```cpp
for (unsigned int i = 0; i < fmt_ctx->nb_streams; ++i) {
    std::cout << std::format("Stream #{}:\n", i);

    AVStream* stream = fmt_ctx->streams[i];
    AVCodecParameters* params = stream->codecpar;
    const char* codec_name = avcodec_get_name(params->codec_id);

    if (params->codec_type == AVMEDIA_TYPE_VIDEO) {
        double fps = av_q2d(stream->avg_frame_rate);
        const char* pix_fmt_name = av_get_pix_fmt_name(static_cast<AVPixelFormat>(params->format));

        std::cout << "  Type: video\n";
        std::cout << std::format("  Codec: {}\n", codec_name);
        std::cout << std::format("  Resolution: {}x{}\n", params->width, params->height);
        std::cout << std::format("  Pixel format: {}\n", pix_fmt_name ? pix_fmt_name : "unknown");
        std::cout << std::format("  Frame rate: {:.2f} fps\n", fps);
    } else if (params->codec_type == AVMEDIA_TYPE_AUDIO) {
        const char* sample_fmt_name = av_get_sample_fmt_name(static_cast<AVSampleFormat>(params->format));
        char layout_desc[64];
        av_channel_layout_describe(&params->ch_layout, layout_desc, sizeof(layout_desc));

        std::cout << "  Type: audio\n";
        std::cout << std::format("  Codec: {}\n", codec_name);
        std::cout << std::format("  Sample format: {}\n", sample_fmt_name ? sample_fmt_name : "unknown");
        std::cout << std::format("  Sample rate: {} Hz\n", params->sample_rate);
        std::cout << std::format("  Channels: {} ({})\n", params->ch_layout.nb_channels, layout_desc);
    } else {
        std::cout << std::format("  Type: other ({})\n", static_cast<int>(params->codec_type));
    }

    if (params->bit_rate > 0) {
        std::cout << std::format("  Bitrate: {} kb/s\n", params->bit_rate / 1000);
    }

    std::cout << "\n";
}
```

This is where most of the useful information lives. `fmt_ctx->streams` is a C array of `AVStream*`, one per elementary stream in the container — video, audio, subtitles, each counted separately. Each `AVStream` carries an `AVCodecParameters*` in its `codecpar` field, describing what's encoded on that stream without needing to actually decode a single frame — this is the struct that makes it possible to answer "what codec is this?" from container metadata alone. `codec_type` is an `AVMediaType` enum (`AVMEDIA_TYPE_VIDEO`, `AVMEDIA_TYPE_AUDIO`, `AVMEDIA_TYPE_SUBTITLE`, and a few rarer ones), and it's what the `if`/`else if` chain branches on to decide which fields even make sense to print.

`avcodec_get_name` turns the numeric `AVCodecID` (an enum) into a human-readable string like `"h264"` or `"aac"` — this works whether or not a decoder for that codec is actually available on the system, since it's just a name lookup table.

For video streams, `width`/`height` are the coded frame dimensions in pixels. `format` holds the pixel format as a raw integer that has to be cast to the `AVPixelFormat` enum before `av_get_pix_fmt_name` can turn it into something readable like `"yuv420p"` — this tells you how color is sampled and packed in each decoded frame, which matters the moment you start doing anything with raw frame data in a later post. `avg_frame_rate` is an `AVRational` — a fraction (numerator/denominator), not a float — so it needs `av_q2d` to convert it into a `double`; FFmpeg uses rationals throughout the API instead of floating-point specifically to avoid rounding error accumulating across long streams, and you'll see the same pattern again once we get to timestamps.

For audio streams, `format` plays the same role but as an `AVSampleFormat` instead — `av_get_sample_fmt_name` reports things like `"fltp"` (32-bit float, planar) or `"s16"` (16-bit signed integer, interleaved), which matters a lot once you're decoding: planar and interleaved audio are laid out completely differently in memory. `sample_rate` is samples per second per channel (44100, 48000, and so on). `ch_layout` replaced the older, simpler "channel count" field in recent FFmpeg versions with a full `AVChannelLayout` describing not just _how many_ channels there are but their spatial arrangement (stereo, 5.1, and so on); `av_channel_layout_describe` renders that into a short human string, which we print alongside the raw channel count from `ch_layout.nb_channels`.

Finally, `bit_rate` here is per-stream — distinct from the container-level `fmt_ctx->bit_rate` from the previous section, which is the sum across all streams. A stream's own bitrate can be `0` if the container doesn't record it explicitly and it wasn't computed during probing, which is why it's guarded the same way as the container-level figure.

`AVCodecParameters` consists of many other useful fields that can be printed. The full definition can be found here: [https://ffmpeg.org/doxygen/9.0/structAVCodecParameters.html](https://ffmpeg.org/doxygen/9.0/structAVCodecParameters.html).

## `avformat_close_input`

```cpp
avformat_close_input(&fmt_ctx);
```

The cleanup counterpart to `avformat_open_input`: it frees the `AVFormatContext` and everything hanging off it — the stream array, codec parameters, internal I/O buffers — and nulls out the pointer you passed it, which is why it takes `AVFormatContext**` rather than `AVFormatContext*`.

## Full listing

```cpp
extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/pixdesc.h>
#include <libavutil/samplefmt.h>
}

#include <format>
#include <iostream>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << std::format("usage: {} <input file>\n", argv[0]);
        return 1;
    }

    const char* input_path = argv[1];
    AVFormatContext* fmt_ctx = nullptr;

    int ret = avformat_open_input(&fmt_ctx, input_path, nullptr, nullptr);
    if (ret < 0) {
        char err_buf[AV_ERROR_MAX_STRING_SIZE];
        av_strerror(ret, err_buf, sizeof(err_buf));
        std::cerr << std::format("avformat_open_input failed: {}\n", err_buf);
        return 1;
    }

    ret = avformat_find_stream_info(fmt_ctx, nullptr);
    if (ret < 0) {
        char err_buf[AV_ERROR_MAX_STRING_SIZE];
        av_strerror(ret, err_buf, sizeof(err_buf));
        std::cerr << std::format("avformat_find_stream_info failed: {}\n", err_buf);
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    std::cout << std::format("Input: {}\n", input_path);
    std::cout << std::format("Format: {} ({})\n", fmt_ctx->iformat->name, fmt_ctx->iformat->long_name);

    if (fmt_ctx->duration != AV_NOPTS_VALUE) {
        double duration_sec = static_cast<double>(fmt_ctx->duration) / AV_TIME_BASE;
        std::cout << std::format("Duration: {:.2f} s\n", duration_sec);
    } else {
        std::cout << "Duration: unknown\n";
    }

    if (fmt_ctx->bit_rate > 0) {
        std::cout << std::format("Overall bitrate: {} kb/s\n", fmt_ctx->bit_rate / 1000);
    }

    std::cout << std::format("Streams: {}\n\n", fmt_ctx->nb_streams);

    for (unsigned int i = 0; i < fmt_ctx->nb_streams; ++i) {
        std::cout << std::format("Stream #{}:\n", i);

        AVStream* stream = fmt_ctx->streams[i];
        AVCodecParameters* params = stream->codecpar;
        const char* codec_name = avcodec_get_name(params->codec_id);

        if (params->codec_type == AVMEDIA_TYPE_VIDEO) {
            double fps = av_q2d(stream->avg_frame_rate);
            const char* pix_fmt_name = av_get_pix_fmt_name(static_cast<AVPixelFormat>(params->format));

            std::cout << "  Type: video\n";
            std::cout << std::format("  Codec: {}\n", codec_name);
            std::cout << std::format("  Resolution: {}x{}\n", params->width, params->height);
            std::cout << std::format("  Pixel format: {}\n", pix_fmt_name ? pix_fmt_name : "unknown");
            std::cout << std::format("  Frame rate: {:.2f} fps\n", fps);
        } else if (params->codec_type == AVMEDIA_TYPE_AUDIO) {
            const char* sample_fmt_name = av_get_sample_fmt_name(static_cast<AVSampleFormat>(params->format));
            char layout_desc[64];
            av_channel_layout_describe(&params->ch_layout, layout_desc, sizeof(layout_desc));

            std::cout << "  Type: audio\n";
            std::cout << std::format("  Codec: {}\n", codec_name);
            std::cout << std::format("  Sample format: {}\n", sample_fmt_name ? sample_fmt_name : "unknown");
            std::cout << std::format("  Sample rate: {} Hz\n", params->sample_rate);
            std::cout << std::format("  Channels: {} ({})\n", params->ch_layout.nb_channels, layout_desc);
        } else {
            std::cout << std::format("  Type: other ({})\n", static_cast<int>(params->codec_type));
        }

        if (params->bit_rate > 0) {
            std::cout << std::format("  Bitrate: {} kb/s\n", params->bit_rate / 1000);
        }

        std::cout << "\n";
    }

    avformat_close_input(&fmt_ctx);
}
```

Here's a sample invocation I used for testing the metadata reader against the Big Buck Bunny test file:

```bash
ragdoll@ragdoll:~/repo/FFmpeg-tutorial$ ./build/debug/Debug/lesson-2 ~/Videos/big_buck_bunny_1080p_stereo.avi
Input: /home/ragdoll/Videos/big_buck_bunny_1080p_stereo.avi
Format: avi (AVI (Audio Video Interleaved))
Duration: 596.46 s
Overall bitrate: 9586 kb/s
Streams: 2

Stream #0:
  Type: video
  Codec: msmpeg4v2
  Resolution: 1920x1080
  Pixel format: yuv420p
  Frame rate: 24.00 fps
  Bitrate: 9328 kb/s

Stream #1:
  Type: audio
  Codec: mp3
  Sample format: fltp
  Sample rate: 48000 Hz
  Channels: 2 (stereo)
  Bitrate: 245 kb/s
```

Note the video (9328 kb/s) and audio (245 kb/s) bitrates sum to 9573 kb/s, not the reported overall 9586 kb/s — a 13 kb/s gap. That's expected, not a bug: `fmt_ctx->bit_rate` reflects the actual byte rate of the file on disk, which includes AVI's own muxing overhead (per-chunk headers, the `idx1` index chunk, RIFF/LIST structure, padding to even byte boundaries) that isn't attributed to either elementary stream. For AVI specifically, the overall figure is commonly read straight from `dwMaxBytesPerSec` in the `avih` header — a value the encoder wrote at authoring time — while the per-stream figures come from each stream's own header (`strh`) or codec-reported info, computed independently. All three numbers are also independently rounded to integer kb/s. So `container bitrate ≈ video + audio + muxing overhead`, rather than an exact sum.

## Where to find the code

The ful set of this lesson lives in the companion repository: [https://github.com/m-konarzewski/FFmpeg-tutorial](https://github.com/m-konarzewski/FFmpeg-tutorial). Clone it and build following the instructions in that repo.
