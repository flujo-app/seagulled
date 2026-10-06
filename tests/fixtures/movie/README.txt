frames.mp4 is procedural test media, not Todd artwork or a product clip.

Generated with:
ffmpeg -f lavfi -i "testsrc2=size=64x64:rate=8:duration=1" -an -c:v libx264 -g 1 -bf 0 -pix_fmt yuv420p -movflags +faststart frames.mp4

Eight intra-coded frames make frame seeks and reverse ordering deterministic in browser tests.
