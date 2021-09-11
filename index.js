module.exports = (Plugin, Library) => {
    const {Logger, Patcher, WebpackModules, DiscordAPI} = Library;
    return class SplitLargeFiles extends Plugin {

        onStart() {
            // Set global modules
            this.fileCheckMod = WebpackModules.getByProps("anyFileTooLarge");
            this.fileUploadMod = WebpackModules.getByProps("instantBatchUpload", "upload");

            /**
             * UPLOAD MODULE
             */

            // Make all file too large checks succeed
            Patcher.instead(this.fileCheckMod, "anyFileTooLarge", (_, __, ___) => {
                return false;
            });

            // Patch upload call to either pass file unaltered if under limit or chunked if over
            Patcher.instead(this.fileUploadMod, "upload", (_, args, original) => {
                const [channelId, file, n] = args;
                // Create a small buffer under limit
                const numChunks = Math.ceil(file.size / this.maxFileUploadSize());
                // Don't do anything if no changes needed
                if (numChunks == 1) {
                    original(...args);
                    return;
                } else if ((file.size + numChunks * 4) / this.maxFileUploadSize() > 255) { // Check to make sure the number of files when chunked with header is not greater than 255 otherwise fail
                    BdApi.showToast("Unable to upload file: File size exceeds max chunk count of 255.", {type:"error"});
                    return;
                }

                BdApi.showToast("Generating file chunks...", {type:"info"});

                // Convert file to bytes
                file.arrayBuffer().then(buffer => {
                    const fileBytes = new Uint8Array(buffer);

                    // Write files with leading bit to determine order
                    // Upload new chunked files
                    const fileList = [];
                    for (let chunk = 0; chunk < numChunks; chunk++) {
                        const baseOffset = chunk * this.maxFileUploadSize();
                        // Write header: "DF" (discord file) then protocol version then chunk number then total chunk count
                        const headerBytes = new Uint8Array(4);
                        headerBytes.set([0xDF, 0x00, chunk & 0xFF, numChunks & 0xFF]);
                        // Slice original file with room for header
                        const bytesToWrite = fileBytes.slice(baseOffset, baseOffset + this.maxFileUploadSize() - 4);
                        // Create new array
                        const mergedArray = new Uint8Array(headerBytes.length + bytesToWrite.length);
                        mergedArray.set(headerBytes);
                        mergedArray.set(bytesToWrite, headerBytes.length);
                        // Add file to array
                        fileList.push(new File([mergedArray], `${chunk}-${file.name}.dlfc`));
                    }
                    this.fileUploadMod.instantBatchUpload(channelId, fileList, n);
                    
                    BdApi.showToast("All files uploading", {type:"success"});
                });
            });

            /**
             * RENDER MODULE
             */


            /**
             * DOWNLOAD MODULE
             */

            Logger.log("Initialization complete");
        }

        // Gets the maximum file upload size for the current server
        maxFileUploadSize() {
            if (!this.fileCheckMod) return 0;

            // Built-in buffer, otherwise file upload fails
            return this.fileCheckMod.maxFileSize(DiscordAPI.currentGuild) - 1000;
        }

        // Looks through current messages to see which ones have (supposedly) complete .dlfc files and make a list of them
        // We are unable to completely verify the integrity of the files without downloading them and checking their headers
        // Checks messages sequentially and will tag messages at the top that don't have complete downloads available for further warnings
        findAvailableDownloads() {
            this.registeredDownloads = []
            for (message in DiscordAPI.currentChannel.messages) {
                for (attachment in message.discordObject.attachments) {
                    // Make sure file (somewhat) follows correct format
                    if (!(isNaN(parseInt(attachment.fileName)) || attachment.fileName.endsWith(".dlfc"))) {
                        continue;
                    }
                    const realName = this.extractRealFileName(attachment.fileName);
                    const existingEntry = this.registeredDownloads.find(element => element.fileName === realName);
                    if (existingEntry) {
                        existingEntry.urls.push(attachment.url)
                        existingEntry.messages.push(message.id)
                    } else {
                        this.registeredDownloads.push({
                            fileName: realName,
                            urls: [attachment.url],
                            messages: [message.id]
                        })
                    }
                }
            }

            // Filter downloads that aren't contiguous
            this.registeredDownloads.filter((value, _, __) => {
                const chunkSet = new Set();
                let highestChunk = 0;
                for (const url in value.urls) {
                    const fileNumber = parseInt(url.slice(url.lastIndexOf("/") + 1));
                    chunkSet.add(fileNumber);
                    highestChunk = Math.max(fileNumber, highestChunk);
                }

                return highestChunk == chunkSet.size;
            })

            // Iterate over remaining downloads and hide all messages except for the one sent first
        }

        // Extracts the original file name from the wrapper
        extractRealFileName(name) {

        }

        // Hides a message with a certain ID
        hideMessage(id) {

        }

        onStop() {
            Patcher.unpatchAll();
        }

        observer(change) {
            // Check to see if new chat message was added
            if (change.addedNodes.length > 0 && change.addedNodes[0].id && change.addedNodes[0].id.includes("chat-message")) {
                Logger.log("New message detected!");
            }
            Logger.log(change);
        }
    }
}
