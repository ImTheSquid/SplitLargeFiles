"use strict";

module.exports = (Plugin, Library) => {
    const {Logger, Patcher, WebpackModules, DiscordAPI, DiscordModules, DOMTools} = Library;
    const {Dispatcher} = DiscordModules;
    return class SplitLargeFiles extends Plugin {

        onStart() {
            // Set globals
            this.fileCheckMod = WebpackModules.getByProps("anyFileTooLarge");
            this.fileUploadMod = WebpackModules.getByProps("instantBatchUpload", "upload");
            this.contextMenuMod = WebpackModules.getByProps("useContextMenuMessage");
            this.registeredDownloads = [];

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

            this.messageCreate = e => {
                // Disregard if not in same channel or in process of being sent
                if (e.channelId !== DiscordAPI.currentChannel.discordObject.id || !e.message.guild_id) {
                    return;
                }
                this.lastMessageCreatedId = e.message.id;
                Logger.log(e);
                this.findAvailableDownloads();
            };

            Dispatcher.subscribe("MESSAGE_CREATE", this.messageCreate);

            this.channelSelect = _ => {
                // Wait a bit to allow DOM to update
                setTimeout(() => this.findAvailableDownloads(), 100);
            };

            Dispatcher.subscribe("CHANNEL_SELECT", this.channelSelect);

            // Manual refresh button in menu

            /**
             * DOWNLOAD MODULE
             */

            Logger.log("Initialization complete");
            BdApi.showToast("Waiting for stuff to load before refreshing downloadables...", {type:"info"});
            setTimeout(() => {
                BdApi.showToast("Downloadables refreshed", {type:"success"});
                this.findAvailableDownloads()
            }, 5000);
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
            this.observer = null;
            this.registeredDownloads = [];
            for (let messageIndex = 0; messageIndex < DiscordAPI.currentChannel.messages.length; messageIndex++) {
                const message = DiscordAPI.currentChannel.messages[messageIndex];
                if (message.discordObject.noDLFC) {
                    continue;
                }

                // Check for DLFC files
                let foundDLFCAttachment = false;
                for (let attachmentIndex = 0; attachmentIndex < message.discordObject.attachments.length; attachmentIndex++) {
                    const attachment = message.discordObject.attachments[attachmentIndex];
                    // Make sure file (somewhat) follows correct format
                    if (!(isNaN(parseInt(attachment.filename)) || attachment.filename.endsWith(".dlfc"))) {
                        continue;
                    }
                    foundDLFCAttachment = true;
                    const realName = this.extractRealFileName(attachment.filename);
                    // Finds the first (latest) entry that has the name that doesn't already have a part of the same index
                    const existingEntry = this.registeredDownloads.find(element => element.filename === realName && !element.found_parts.has(parseInt(attachment.filename)));
                    if (existingEntry) {
                        existingEntry.urls.push(attachment.url);
                        existingEntry.messages.push({id: message.id, date: message.timestamp});
                        existingEntry.found_parts.add(parseInt(attachment.filename));
                    } else {
                        this.registeredDownloads.unshift({
                            filename: realName,
                            urls: [attachment.url],
                            messages: [{id: message.id, date: message.timestamp}],
                            found_parts: new Set([parseInt(attachment.filename)])
                        });
                    }
                }

                // Tag object if no attachments found to prevent unneeded repeat scans
                if (!foundDLFCAttachment) {
                    message.discordObject.noDLFC = true;
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
            });

            // Iterate over remaining downloads and hide all messages except for the one sent first
            this.registeredDownloads.forEach(download => {
                download.messages.sort((first, second) => first.date - second.date);
                // Rename first message to real file name

                for (let messageIndex = 1; messageIndex < download.messages.length; messageIndex++) {
                    this.hideMessage(download.messages[messageIndex].id);
                }
            });
        }

        // Extracts the original file name from the wrapper
        extractRealFileName(name) {
            return name.slice(name.indexOf("-") + 1, name.length - 5);
        }

        // Hides a message with a certain ID
        hideMessage(id) {
            const element = DOMTools.query(`#chat-messages-${id}`);
            if (element) {
                element.setAttribute("hidden", "");
            } else {
                Logger.error(`Unable to find DOM object with selector #chat-messages-${id}`);
            }
        }

        onStop() {
            Patcher.unpatchAll();
            Dispatcher.unsubscribe("MESSAGE_CREATE", this.messageCreate);
            Dispatcher.unsubscribe("CHANNEL_SELECT", this.channelSelect);
        }
    }
}
