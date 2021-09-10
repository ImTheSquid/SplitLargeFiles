module.exports = (Plugin, Library) => {
    const {Logger, Patcher, WebpackModules, DiscordAPI} = Library;
    return class SplitLargeFiles extends Plugin {

        onStart() {
            // Set global modules
            this.fileCheckMod = WebpackModules.getByProps("anyFileTooLarge");
            this.fileUploadMod = WebpackModules.getByProps("instantBatchUpload");

            // Make all file too large checks succeed
            Patcher.instead("", this.fileCheckMod.prototype, "anyFileTooLarge", (thisObj, args, original) => {
                return false;
            });

            // Patch upload call to either pass file unaltered if under limit or chunked if over
            Patcher.instead("", this.fileUploadMod.prototype, "upload", (thisObj, args, original) => {
                const [channelId, file] = args;
                const fileName = file.name;
                const numChunks = Math.ceil(file.size / thisObj.maxFileUploadSize());
                // Don't do anything if no changes needed
                if (file.size <= thisObj.maxFileUploadSize()) {
                    original(args);
                    return;
                } else if (file.size + numChunks * 4 / thisObj.maxFileUploadSize() > 255) { // Check to make sure the number of files when chunked with header is not greater than 255 otherwise fail
                    BdApi.showToast("Unable to upload file: File size exceeds max chunk count of 255.", {type:"error"});
                    return;
                }

                BdApi.showToast("Generating file chunks...", {type:"info"});

                // Create temp directory
                const fs = require("fs");
                const path = require("path");
                const os = require("os");
                const crypto = require("crypto");
                const id = crypto.randomBytes(16).toString("hex");
                let stagingDir;
                try {
                    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `staging-${id}`));
                } catch (e) {
                    BdApi.showToast("Unable to upload file: Unable to create chunking directory.", {type:"error"});
                    Logger.stacktrace(e);
                    return;
                }

                // Convert file to bytes
                file.arrayBuffer().then(buffer => {
                    const fileBytes = Uint8Array(buffer);

                    // Write files with leading bit to determine order
                    for (let chunk = 0; chunk < numChunks; chunk++) {
                        const baseOffset = chunk * thisObj.maxFileUploadSize();
                        const bytesToWrite = fileBytes.slice(baseOffset, baseOffset + thisObj.maxFileUploadSize() - 1);
                        // Write header: "DF" (discord file) then protocol version then chunk number then total chunk count
                        bytesToWrite.unshift(0xDF, 0x00, chunk, numChunks);
                        // Write file to temp directory
                        fs.writeFileSync(path.join(stagingDir, `${chunk}-${fileName}.dlfc`));
                    }

                    // Upload new chunked files
                    for (let chunkFile = 0; chunkFile < numChunks; chunkFile) {
                        args.file = new File([], path.join(stagingDir, `${chunkFile}-${fileName}.dlfc`));
                        original(args);
                    }
                    
                    BdApi.showToast("All files uploaded.", {type:"success"});
                });
            });

            Logger.log("Initialization complete");
        }

        // Gets the maximum file upload size for the current server
        maxFileUploadSize() {
            if (!this.fileCheckMod) return 0;

            return this.fileCheckMod.maxFileSize(DiscordAPI.currentGuild);
        }

        onStop() {
            Patcher.unpatchAll();
        }
    }
}
