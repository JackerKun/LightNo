#!/bin/sh
set -eu

source_root="$(cd "$SRCROOT/.." && pwd)"
destination="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/Web"
mkdir -p "$destination"
for file in index.html manifest.webmanifest; do
  cp "$source_root/$file" "$destination/$file"
done
for directory in js css assets; do
  mkdir -p "$destination/$directory"
  /usr/bin/rsync -a --delete --exclude='.DS_Store' "$source_root/$directory/" "$destination/$directory/"
done
