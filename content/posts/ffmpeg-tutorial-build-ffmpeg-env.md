+++ 
draft = false
date = 2026-09-18T15:43:22+02:00
title = "Lesson 1: Building the FFmpeg development environment"
tags = ["build", "compile", "nvidia"]
categories = ["FFmpeg"]
+++

Before writing a single line of C++, you need a build of FFmpeg you actually control — with debug symbols reachable, the right protocols and codecs compiled in, and (for some of you) hardware acceleration wired up. The prebuilt packages your distro ships are usually stripped down and built as a static blob you can't easily link against from your own code, so for this series we're building from source.

## Installing build dependencies

Before running `configure`, install the toolchain and the `-dev` headers for the libraries FFmpeg links against (on Debian/Ubuntu; adapt package names for your distro):

```bash
sudo apt-get update -qq && sudo apt-get -y install \
        autoconf \
        automake \
        build-essential \
        cmake \
        git-core \
        libass-dev \
        libfreetype6-dev \
        libgnutls28-dev \
        libmp3lame-dev \
        libsdl2-dev \
        libtool \
        libva-dev \
        libvdpau-dev \
        libvorbis-dev \
        libxcb1-dev \
        libxcb-shm0-dev \
        libxcb-xfixes0-dev \
        libvpx-dev \
        libxml2-dev \
        meson \
        ninja-build \
        pkg-config \
        texinfo \
        wget \
        yasm \
        zlib1g-dev
```

A few worth calling out: `autoconf`/`automake`/`libtool`/`build-essential` are the base toolchain `configure`/`make` need; `meson`/`ninja-build` are required because some of FFmpeg's dependencies (not FFmpeg itself) build with Meson rather than autotools. `pkg-config` is how `configure` locates the `-dev` packages below it — without it, a library can be installed and still get reported as missing. `yasm` is the assembler FFmpeg's hand-written SIMD routines are assembled with; skipping it silently falls back to slower generic C paths for some codecs. The `lib*-dev` packages are the headers/`.pc` files for the encoder, container-format, and windowing libraries enabled in the configure scripts below (libmp3lame, libvorbis, libvpx, libass, libxml2, and so on) — `libva-dev`/`libvdpau-dev` specifically are Linux hardware-acceleration APIs, present here even for the CPU-only profile since `configure` probes for them regardless of which profile you run.

## Getting the source

We're building off the `release/9.0` branch of the upstream FFmpeg repository — a stable release branch, rather than tracking `master`, so the API surface won't shift under you mid-series.

```bash
git clone --branch release/9.0 --depth 1 https://github.com/FFmpeg/FFmpeg.git
cd FFmpeg
```

## Two build profiles

The configure script accepts a long list of `--enable-*`/`--disable-*` flags that decide which protocols, demuxers, muxers, filters, and codec libraries get compiled in. Rather than enabling everything (which balloons build time and binary size for features you won't use), we're using two purpose-built profiles: one with NVIDIA GPU acceleration, one without. Pick whichever matches your hardware. For NVIDIA GPU it is required to set the environment correctly (out of the scope of this tutorial), so the commands like `nvidia-smi` and `nvcc` works fine.

### Profile A: with NVIDIA (CUDA/NVENC/NVDEC)

```bash
#!/usr/bin/env bash

set -e

# Build / toolchain
./configure \
    --ld=g++ \
    --extra-libs="-lpthread -lm" \
    --enable-pthreads \
    --enable-pic \
    --enable-rpath \
    \
    --enable-lto \
    --optflags="-O3 -march=native -mtune=native" \
    \
    --disable-debug \
    --disable-static \
    --enable-shared \
    \
    --enable-gpl \
    --enable-nonfree \
    \
    --enable-network \
    --enable-protocol=rtp \
    --enable-protocol=tcp \
    --enable-protocol=udp \
    --enable-protocol=http \
    --enable-openssl \
    --enable-protocol=https \
    --enable-demuxer=rtsp \
    --enable-demuxer=dash \
    --enable-muxer=rtsp \
    \
    --enable-cuda-nvcc \
    --enable-cuda \
    --enable-ffnvcodec \
    --extra-cflags="-I/usr/local/cuda/include" \
    --extra-ldflags="-L/usr/local/cuda/lib64" \
    \
    --enable-nvenc \
    --enable-nvdec \
    \
    --enable-filter=scale_cuda \
    --enable-filter=overlay_cuda \
    --enable-filter=hwupload_cuda \
    --enable-filter=hwdownload \
    --enable-filter=hwmap \
    \
    --enable-filter=drawtext \
    --enable-libass \
    --enable-libfreetype \
    --enable-libfontconfig \
    --enable-libharfbuzz \
    \
    --enable-libmp3lame \
    --enable-libvorbis \
    \
    --enable-libx264 \
    --enable-libx265 \
    --enable-libvpx \
    \
    --enable-libxml2 \
    \
    --logfile=ffmpeg_config.log
```

### Profile B: CPU only, no NVIDIA

```bash
#!/usr/bin/env bash

set -e

./configure \
    --ld=g++ \
    --extra-libs="-lpthread -lm" \
    --enable-pthreads \
    --enable-pic \
    --enable-rpath \
    \
    --optflags="-O3 -march=native -mtune=native" \
    --enable-lto \
    \
    --disable-static \
    --enable-shared \
    \
    --enable-gpl \
    --enable-nonfree \
    \
    --enable-network \
    --enable-openssl \
    \
    --enable-protocol=http \
    --enable-protocol=https \
    --enable-protocol=rtp \
    --enable-protocol=rtsp \
    --enable-protocol=tcp \
    --enable-protocol=udp \\
    --enable-demuxer=dash \
    --enable-demuxer=rtsp \
    --enable-muxer=rtsp \
    \
    --enable-filter=drawtext \
    --enable-libass \
    --enable-libfreetype \
    --enable-libfontconfig \
    --enable-libharfbuzz \
    \
    --enable-libmp3lame \
    --enable-libvorbis \
    \
    --enable-libx264 \
    --enable-libx265 \
    --enable-libvpx \
    \
    --enable-libxml2 \
    \
    --logfile=ffmpeg_config.log
```

## What these flags actually mean

**Toolchain and build type.** `--ld=g++` links with the C++ linker rather than the default C one — needed because later in this series we'll be linking C++ translation units against these libraries, and some of the optional dependencies (libass, in particular) pull in C++ objects. `--enable-pic` produces position-independent code, required for `--enable-shared`; `--enable-rpath` embeds the library search path into the built binaries so you don't have to fight `LD_LIBRARY_PATH` later. `--disable-static --enable-shared` builds `.so` libraries instead of `.a` archives — this is the form you'll actually link your own C++ programs against. `--enable-lto` and the `-O3 -march=native -mtune=native` optflags trade portability (the binary is tuned for _this_ CPU) for performance, which is fine for a local dev/tutorial build but not what you'd ship.

**Licensing.** `--enable-gpl` and `--enable-nonfree` unlock components (x264, x265, and a few others) that aren't available under FFmpeg's default LGPL build. This matters for redistribution — a GPL/nonfree build isn't something you can freely ship in a closed-source product — but for learning and local experimentation it's the right choice, since it's also the norm you'll actually encounter in the wild.

**Network and streaming.** `--enable-network` turns on FFmpeg's networking layer at all; the `--enable-protocol=*` flags then enable specific I/O protocols (`tcp`/`udp` as transports, `http`/`https` for progressive/DASH-style delivery, `rtp`/`rtsp` for real-time streaming). `--enable-openssl` is what makes `https` actually work — without a TLS backend the `https` protocol handler can't establish a secure connection. `--enable-demuxer=dash` and the `rtsp` demuxer/muxer pair are there because later posts in this series touch both adaptive streaming (DASH) and RTSP-based live sources.

**GPU acceleration (Profile A only).** `--enable-cuda`, `--enable-cuda-nvcc`, and `--enable-ffnvcodec` pull in NVIDIA's CUDA toolkit and the `ffnvcodec` headers that describe NVIDIA's hardware codec API; the `--extra-cflags`/`--extra-ldflags` point the build at your local CUDA installation. `--enable-nvenc`/`--enable-nvdec` are the actual hardware encoder/decoder wrappers. The `--enable-filter=*_cuda` and `hwupload_cuda`/`hwdownload`/`hwmap` filters let you scale and overlay video _while it stays resident in GPU memory_, and move it to/from the GPU only when you actually need to touch it on the CPU side — avoiding a round-trip that would otherwise erase most of the performance benefit of hardware encoding.

**Text, subtitles, and fonts.** `--enable-filter=drawtext` plus `libfreetype`/`libfontconfig`/`libharfbuzz` are what let FFmpeg render text (timestamps, watermarks, captions) onto frames using real font rendering and shaping rather than a bitmap font. `--enable-libass` adds support for burning in styled `.ass`/`.ssa` subtitles.

**Audio and video codecs.** `libmp3lame` and `libvorbis` add MP3 and Vorbis encoding (FFmpeg can decode most formats without extra libraries, but encoding often needs an external encoder library). `libx264`/`libx265` are the reference H.264/HEVC encoders — almost certainly what you want over FFmpeg's built-in encoders for anything quality-sensitive — and `libvpx` adds VP8/VP9.

**Miscellaneous.** `--enable-libxml2` is a dependency pulled in by the DASH demuxer, which needs to parse the XML manifest (MPD) that describes a DASH stream. `--logfile=ffmpeg_config.log` just redirects `configure`'s output to a file instead of your terminal, which is handy since a failed configure run can produce a _lot_ of diagnostic output to scroll back through.

## Building and installing

Once `configure` finishes successfully, build with as many parallel jobs as you have CPU cores, then install:

```bash
make -j"$(nproc)"
sudo make install
sudo ldconfig
```

`ldconfig` refreshes the dynamic linker's cache so newly installed shared libraries are found at runtime — easy to forget, and the usual cause of an `error while loading shared libraries` right after a from-source install.

## Verifying the build

```bash
ffmpeg -version
ffmpeg -protocols 2>&1 | grep -E "https|rtsp"
ffmpeg -encoders 2>&1 | grep -E "libx264|libx265|nvenc"
```

The first command confirms the binary picked up your build (check the configuration line it prints — it should list the flags above). The second and third confirm the protocols and encoders you asked for actually made it into the build; a flag silently failing to take effect because a dependency wasn't found is the most common way this step goes wrong.

## Where to find the code

The full set of lessons for this series lives in the companion repository: [FFmpeg-tutorial](https://github.com/m-konarzewski/FFmpeg-tutorial). Clone it and build following the instructions in that repo.

The quick step by step commands:

```bash
git clone --recurse-submodules https://github.com/m-konarzewski/FFmpeg-tutorial.git
cd FFmpeg-tutorial
./build.sh debug
./build/debug/Debug/lesson-1
```

You should see the following output:

```txt
FFmpeg libavutil: n9.0.2
SDL3: 3005000
```

Now you're all set and ready for the next lesson!
