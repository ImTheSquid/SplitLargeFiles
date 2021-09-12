"use strict";

module.exports = (Plugin, Library) => {
    const {Logger, Patcher, WebpackModules, DiscordAPI, DiscordModules, DOMTools} = Library;
    const {Dispatcher, React, ReactDOM} = DiscordModules;

    const concatTypedArrays = (a, b) => { // a, b TypedArray of same type
        var c = new (a.constructor)(a.length + b.length);
        c.set(a, 0);
        c.set(b, a.length);
        return c;
    }

    const isSetLinear = set => {
        for (let setIndex = 0; setIndex < set.length; setIndex++) {
            if (!set.has(setIndex)) {
                return false;
            }
        }
        return true;
    }

    const downloadFiles = download => {
        const https = require("https");
        const os = require("os");
        const fs = require("fs");
        const path = require("path");
        const crypto = require("crypto");
        const id = crypto.randomBytes(16).toString("hex");
        const tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), `dlfc-download-${id}`));

        let promises = [];
        for (const url of download.urls) {
            const chunkName = url.slice(url.lastIndexOf("/") + 1);
            const dest = path.join(tempFolder, chunkName);
            const file = fs.createWriteStream(dest);
            const downloadPromise = new Promise((resolve, reject) => {
                https.get(url, response => {
                    response.pipe(file);
                    file.on("finish", () => {
                        file.close();
                        resolve(chunkName);
                    })
                }).on("error", err => {
                    fs.unlink(dest);
                    reject(err);
                });
            });
            
            promises.push(downloadPromise);
        }

        Promise.all(promises).then(names => {
            Logger.log(names);

            // Load files into array
            let fileBuffers = [];
            for (const name of names) {
                fileBuffers.push(fs.readFileSync(path.join(tempFolder, name)));
            }

            // Sort buffers
            fileBuffers = fileBuffers.filter(buffer => buffer.length >= 5 && buffer[0] === 0xDF && buffer[1] === 0);
            fileBuffers.sort((left, right) => left[2] - right[2]);

            // Check that all buffers have a correct header and that each chunk is less than the max number and appears only once
            let numChunks = 0;
            let chunkSet = new Set();
            let outputFile = fs.createWriteStream(path.join(tempFolder, `${download.filename}`));
            for (const buffer of fileBuffers) {
                if (buffer[2] >= buffer[3] || (numChunks !== 0 && buffer[3] > numChunks)) {
                    BdApi.showToast("Reassembly failed: Some chunks are not part of the same file", {type: "error"});
                    outputFile.close();
                    return;
                }
                chunkSet.add(buffer[2]);
                numChunks = buffer[3];
                outputFile.write(buffer.slice(4));
            }
            // Go through chunk set one by one to make sure that the values are contiguous
            if (!isSetLinear(chunkSet) || chunkSet.size === 0) {
                BdApi.showToast("Reassembly failed: Some chunks do not exist", {type: "error"});
                outputFile.close();
                return;
            }
            outputFile.close(() => {
                fs.copyFileSync(path.join(tempFolder, `${download.filename}`), path.join(os.homedir(), 'Downloads', `${download.filename}`));
                BdApi.showToast("File reassembled successfully", {type: "success"});
                fs.rmdirSync(tempFolder, {recursive: true});
            });
        })
        .catch(err => {
            Logger.error(err);
            BdApi.showToast(`Failed to download file`, {type: "error"});
            fs.rmdirSync(tempFolder, {recursive: true});
        })
    }

    class NamedDownloadLink extends React.Component {
        constructor(props) {
            super(props);
            this.linkWasClicked = this.linkWasClicked.bind(this);
            this.state = {
                elementClasses: props.classes,
                download: props.download
            }
        }

        linkWasClicked(e) {
            e.preventDefault();
            BdApi.showToast("Downloading files...", {type: "info"});
            downloadFiles(this.state.download);
        }

        render() {
            return React.createElement("a", {class: this.state.elementClasses, onClick: this.linkWasClicked, href:"/"}, this.state.download.filename);
        }
    }

    class SplitLargeFiles extends Plugin {
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
                const numChunksWithHeaders = Math.ceil(file.size / (this.maxFileUploadSize() - 4));
                // Don't do anything if no changes needed
                if (numChunks == 1) {
                    original(...args);
                    return;
                } else if (numChunksWithHeaders > 255) { // Check to make sure the number of files when chunked with header is not greater than 255 otherwise fail
                    BdApi.showToast("Unable to upload file: File size exceeds max chunk count of 255.", {type: "error"});
                    return;
                }

                BdApi.showToast("Generating file chunks...", {type: "info"});

                // Convert file to bytes
                file.arrayBuffer().then(buffer => {
                    const fileBytes = new Uint8Array(buffer);

                    // Write files with leading bit to determine order
                    // Upload new chunked files
                    const fileList = [];
                    for (let chunk = 0; chunk < numChunksWithHeaders; chunk++) {
                        // Get an offset with size 
                        const baseOffset = chunk * (this.maxFileUploadSize() - 4);
                        // Write header: "DF" (discord file) then protocol version then chunk number then total chunk count
                        const headerBytes = new Uint8Array(4);
                        headerBytes.set([0xDF, 0x00, chunk & 0xFF, numChunks & 0xFF]);
                        // Slice original file with room for header
                        const bytesToWrite = fileBytes.slice(baseOffset, baseOffset + this.maxFileUploadSize() - 4);
                        // Add file to array
                        fileList.push(new File([concatTypedArrays(headerBytes, bytesToWrite)], `${chunk}-${numChunks - 1}_${file.name}.dlfc`));
                    }
                    this.fileUploadMod.instantBatchUpload(channelId, fileList, n);
                    
                    BdApi.showToast("All files uploading", {type: "success"});
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
                this.findAvailableDownloads();
            };

            Dispatcher.subscribe("MESSAGE_CREATE", this.messageCreate);

            this.channelSelect = _ => {
                // Wait a bit to allow DOM to update
                setTimeout(() => this.findAvailableDownloads(), 100);
            };

            Dispatcher.subscribe("CHANNEL_SELECT", this.channelSelect);

            // Manual refresh button in menu

            // Handle deletion of part of file to delete all other parts either by user or automod

            /**
             * COMPLETION
             */

            Logger.log("Initialization complete");
            BdApi.showToast("Waiting for BetterDiscord to load before refreshing downloadables...", {type: "info"});
            setTimeout(() => {
                BdApi.showToast("Downloadables refreshed", {type: "success"});
                this.findAvailableDownloads()
            }, 8000);
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
            for (const message of DiscordAPI.currentChannel.messages) {
                // If object already searched with nothing then skip
                if (message.discordObject.noDLFC) {
                    continue;
                }

                // Check for DLFC files
                let foundDLFCAttachment = false;
                for (const attachment of message.discordObject.attachments) {
                    // Make sure file (somewhat) follows correct format
                    if (isNaN(parseInt(attachment.filename)) || !attachment.filename.endsWith(".dlfc")) {
                        continue;
                    }
                    foundDLFCAttachment = true;
                    const realName = this.extractRealFileName(attachment.filename);
                    // Finds the first (latest) entry that has the name that doesn't already have a part of the same index
                    const existingEntry = this.registeredDownloads.find(element => element.filename === realName && !element.foundParts.has(parseInt(attachment.filename)));
                    if (existingEntry) {
                        existingEntry.urls.push(attachment.url);
                        existingEntry.messages.push({id: message.id, date: message.timestamp});
                        existingEntry.foundParts.add(parseInt(attachment.filename));
                        existingEntry.totalSize += attachment.size;
                    } else {
                        this.registeredDownloads.unshift({
                            filename: realName,
                            urls: [attachment.url],
                            messages: [{id: message.id, date: message.timestamp}],
                            foundParts: new Set([parseInt(attachment.filename)]),
                            totalSize: attachment.size
                        });
                    }
                }

                // Tag object if no attachments found to prevent unneeded repeat scans
                if (!foundDLFCAttachment) {
                    message.discordObject.noDLFC = true;
                }
            }
            Logger.log(`Downloads found: ${this.registeredDownloads.length}`);

            // Filter downloads that aren't contiguous
            this.registeredDownloads = this.registeredDownloads.filter((value, _, __) => {
                const chunkSet = new Set();
                let highestChunk = 0;
                Logger.log(value);
                for (const url of value.urls) {
                    const filename = url.slice(url.lastIndexOf("/") + 1);
                    const fileNumber = parseInt(filename);
                    const fileTotal = parseInt(filename.slice(filename.indexOf("-") + 1));
                    chunkSet.add(fileNumber);
                    if (highestChunk === 0) {
                        highestChunk = fileTotal;
                    } else if (highestChunk !== fileTotal) {
                        return false;
                    }
                }

                return isSetLinear(chunkSet) && highestChunk + 1 === chunkSet.size;
            });

            Logger.log(`Downloads to hide: ${this.registeredDownloads.length}`);

            // Iterate over remaining downloads and hide all messages except for the one sent first
            this.registeredDownloads.forEach(download => {
                download.messages.sort((first, second) => first.date - second.date);
                // Rename first message to real file name
                this.formatFirstDownloadMessage(download.messages[0].id, download);

                // Hide the rest of the messages
                for (let messageIndex = 1; messageIndex < download.messages.length; messageIndex++) {
                    this.hideMessage(download.messages[messageIndex].id);
                }
            });
        }

        // Extracts the original file name from the wrapper
        extractRealFileName(name) {
            return name.slice(name.indexOf("_") + 1, name.length - 5);
        }

        formatFirstDownloadMessage(id, download) {
            const {name, totalSize} = download;
            // Find message div
            const messageDiv = DOMTools.query(`#chat-messages-${id}`);

            // Find and edit name and size data
            const attachmentContainer = this.findFirstInDOMChildren(messageDiv, /container/, element => element.className);
            if (!attachmentContainer) {
                Logger.error(`Unable to find message attachment contents for message with ID ${id}`);
                return;
            }

            const attachmentInner = this.findFirstInDOMChildren(attachmentContainer.children[0].children[0], /attachmentInner/, element => element.className);
            if (!attachmentInner) {
                Logger.error(`Unable to find attachmentInner for message with ID ${id}`);
                return;
            }

            const fileSize = this.findFirstInDOMChildren(attachmentInner, /metadata/, element => element.className);
            if (!fileSize) {
                Logger.error(`Unable to find filesize metadata for message with ID ${id}`);
            }

            fileSize.innerHTML = `${(totalSize / 1000000).toFixed(2)} MB Chunk File`;

            // Change links to run internal download and reassemble function
            const namedLinkWrapper = this.findFirstInDOMChildren(attachmentInner, /filenameLinkWrapper/, element => element.className);
            if (!namedLinkWrapper) {
                Logger.error(`Unable to find named link for message with ID ${id}`);
            }

            // const anchor = namedLinkWrapper.children[0];
            // anchor.remove();
            ReactDOM.render(React.createElement(NamedDownloadLink, {elementClasses: namedLinkWrapper.children[0].class, download: download}), namedLinkWrapper);
        }

        // childFormat: a function that takes an element and returns the property to be tested by the regex
        findFirstInDOMChildren(element, regex, childFormat) {
            for (const child of element.children) {
                if (regex.test(childFormat(child))) {
                    return child;
                }
            }
            return null;
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
    };

    return SplitLargeFiles;
}
