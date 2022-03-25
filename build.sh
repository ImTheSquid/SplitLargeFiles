#!/bin/sh

# ESBuild
esbuild index.jsx --bundle --outfile=bundled.js --platform=node --external:electron

npm run build_plugin SplitLargeFiles --prefix ../../
cp ../../release/SplitLargeFiles.plugin.js .

# Remove all header data that is undefined
sed -i '/^ \* @.*undefined$/d' ./SplitLargeFiles.plugin.js