# Split Large Files
Split large files is a BetterDiscord plugin that makes sending large files easy by breaking up big files into smaller ones that get reassembled upon download. 

The Node engine that Discord runs on only supports a max file size of 2 GB, so don't expect to upload files above 1.5 GB. An error may not be displayed on failure if you try to upload files greater than 1 GB.

If you are unable to install BetterDiscord or Split Large Files and you want to reassemble a set of chunk files someone sent you, go [here](https://imthesquid.github.io/).

## Main Features
Automatic file splitting when uploading files larger than the upload limit...

![File split into multiple chunks](images/chunks.png)

That gets visually reassembled once uploading is complete.

![File visually reassembled into original file](images/visualReassembly.png)

Downloading the file results in the reassembled original file being put in the directory of your choice.

## Other Features
- Automatically open file manager once download is complete
- Manual refresh controls both per-message and per-channel in context menus
- Automatic full-file deletion for your own chunk files that doesn't spam Discord's API
- Full support for new multi-upload system with automatic rate limiting to prevent API spam

## Installation
### Github
1. Download the `SplitLargeFiles.plugin.js` file
2. Drag it into your BetterDiscord plugins directory

## Frequently Asked Questions and Common Problems
- Problem: Discord crashes when I try to upload a large file.

  - Solution: Try uploading a different file of similar size. If the new file works, there is something wrong with the original file. You can try moving it somewhere else and see if it works. If the new file doesn't work, contact me and I will take a bug report.
