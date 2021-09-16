"use strict";

module.exports = (Plugin, Library) => {
    const {Logger, Patcher, WebpackModules, DiscordAPI, DiscordModules, DOMTools, ReactTools, DiscordContextMenu} = Library;
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
            return React.createElement("a", {className: this.state.elementClasses, onClick: this.linkWasClicked, href: "/"}, this.state.download.filename);
        }
    }

    class IconDownloadLink extends React.Component {
        constructor(props) {
            super(props);
            this.linkWasClicked = this.linkWasClicked.bind(this);
            this.state = {
                svgClasses: props.svgClasses,
                elementClasses: props.classes,
                innerHTML: props.innerHTML,
                download: props.download
            }
        }

        linkWasClicked(e) {
            e.preventDefault();
            BdApi.showToast("Downloading files...", {type: "info"});
            downloadFiles(this.state.download);
        }

        render() {
            // Can't create React child component from original SVG due to lack of ability to properly inline divs in anchors
            return React.createElement("a", {children: this.state.innerHTML, className: this.state.elementClasses, onClick: this.linkWasClicked, href: "/"}, React.createElement("svg", {
                class: this.state.svgClasses,
                "aria-hidden": "false",
                width: "24",
                height: "24",
                viewBox: "0 0 24 24"
              }, React.createElement("path", {
                fill: "currentColor",
                "fill-rule": "evenodd",
                "clip-rule": "evenodd",
                d: "M16.293 9.293L17.707 10.707L12 16.414L6.29297 10.707L7.70697 9.293L11 12.586V2H13V12.586L16.293 9.293ZM18 20V18H20V20C20 21.102 19.104 22 18 22H6C4.896 22 4 21.102 4 20V18H6V20H18Z"
              })));
        }
    }

    class SplitLargeFiles extends Plugin {
        onStart() {
            // Set globals
            this.fileCheckMod = WebpackModules.getByProps("anyFileTooLarge");
            this.fileUploadMod = WebpackModules.getByProps("instantBatchUpload", "upload");
            this.contextMenuMod = WebpackModules.getByProps("useContextMenuMessage");
            this.messageContextMenu = WebpackModules.find(mod => mod.default?.displayName === "MessageContextMenu");
            this.textChannelContextMenu = WebpackModules.find(mod => mod.default?.displayName === "ChannelListTextChannelContextMenu");

            this.registeredDownloads = [];
            this.incompleteDownloads = [];

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

            // Manual refresh button in both channel and message menus
            Patcher.after(this.messageContextMenu, "default", (_, [arg], ret) => {
                ret.props.children.splice(4, 0, DiscordContextMenu.buildMenuItem({type: "separator"}), DiscordContextMenu.buildMenuItem({label: "Refresh Downloadables", action: () => { 
                    this.findAvailableDownloads();
                    BdApi.showToast("Downloadables refreshed", {type: "success"});
                }}));
                // Due to issues with the permissions API only allow users to delete their own download fragments
                const incomplete = this.incompleteDownloads.find(download => download.messages.find(message => message.id === arg.message.id) && download.owner === DiscordAPI.currentUser.discordObject.id);
                if (incomplete) {
                    ret.props.children.splice(6, 0, DiscordContextMenu.buildMenuItem({label: "Delete Download Fragments", danger: true, action: () => {
                        this.deleteDownload(incomplete);
                        this.findAvailableDownloads();
                    }}));
                }
            });

            Patcher.after(this.textChannelContextMenu, "default", (_, [arg], ret) => {
                if (arg.channel.id === DiscordAPI.currentChannel.discordObject.id) {
                    ret.props.children.splice(1, 0, DiscordContextMenu.buildMenuItem({type: "separator"}), DiscordContextMenu.buildMenuItem({label: "Refresh Downloadables", action: () => { 
                        this.findAvailableDownloads();
                        BdApi.showToast("Downloadables refreshed", {type: "success"});
                    }}));
                }
            });

            // Handle deletion of part of file to delete all other parts either by user or automod
            this.messageDelete = e => {
                // Disregard if not in same channel
                if (e.channelId !== DiscordAPI.currentChannel.discordObject.id) {
                    return;
                }
                const download = this.registeredDownloads.find(element => element.messages.find(message => message.id == e.id));
                if (download) {
                    this.deleteDownload(download, e.id);
                }
                this.findAvailableDownloads();
            }

            Dispatcher.subscribe("MESSAGE_DELETE", this.messageDelete);

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
            this.incompleteDownloads = [];
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
                            owner: message.discordObject.author.id,
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

            // Filter downloads that aren't contiguous
            this.registeredDownloads = this.registeredDownloads.filter((value, _, __) => {
                const chunkSet = new Set();
                let highestChunk = 0;
                for (const url of value.urls) {
                    const filename = url.slice(url.lastIndexOf("/") + 1);
                    const fileNumber = parseInt(filename);
                    const fileTotal = parseInt(filename.slice(filename.indexOf("-") + 1));
                    chunkSet.add(fileNumber);
                    if (highestChunk === 0) {
                        highestChunk = fileTotal;
                    } else if (highestChunk !== fileTotal) {
                        this.incompleteDownloads.push(value);
                        return false;
                    }
                }

                const result = isSetLinear(chunkSet) && highestChunk + 1 === chunkSet.size;
                if (!result) {
                    this.incompleteDownloads.push(value);
                }
                return result;
            });

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
            const attachment = attachmentContainer.children[0].children[0];

            const attachmentInner = this.findFirstInDOMChildren(attachment, /attachmentInner/, element => element.className);
            if (!attachmentInner) {
                Logger.error(`Unable to find attachmentInner for message with ID ${id}`);
                return;
            }

            const fileSize = this.findFirstInDOMChildren(attachmentInner, /metadata/, element => element.className);
            if (!fileSize) {
                Logger.error(`Unable to find filesize metadata for message with ID ${id}`);
                return;
            }

            fileSize.innerHTML = `${(totalSize / 1000000).toFixed(2)} MB Chunk File`;

            // Change links to run internal download and reassemble function
            const namedLinkWrapper = this.findFirstInDOMChildren(attachmentInner, /filenameLinkWrapper/, element => element.className);
            if (!namedLinkWrapper) {
                Logger.error(`Unable to find named link for message with ID ${id}`);
                return;
            }

            const iconDownloadLink = this.findFirstInDOMChildren(attachment, /.+/, element => element.href);
            if (!iconDownloadLink) {
                if (!this.findFirstInDOMChildren(attachment, /iconChunkDownloader/, element=>element.className)) {
                    Logger.error(`Unable to find icon link for message with ID ${id}`);
                }
                return;
            }
            iconDownloadLink.remove();
            const newIconDownloadContainer = document.createElement("div");
            newIconDownloadContainer.className = "iconChunkDownloader";
            attachment.appendChild(newIconDownloadContainer);

            ReactDOM.render(React.createElement(IconDownloadLink, {classes: iconDownloadLink.className, svgClasses: iconDownloadLink.children[0].className.baseVal, download: download}), newIconDownloadContainer);
            ReactDOM.render(React.createElement(NamedDownloadLink, {classes: namedLinkWrapper.children[0].className, download: download}), namedLinkWrapper);
        }

        // childFormat: a function that takes an element and returns the property to be tested by the regex
        findFirstInDOMChildren(element, regex, childFormat) {
            for (const child of element.children) {
                if (childFormat(child) && regex.test(childFormat(child))) {
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

        // Deletes messages in a staggered manner to avoid API rate limiting
        deleteDownload(download, excludeMessage) {
            let delayCount = 0;
            for (const message of DiscordAPI.currentChannel.messages) {
                const downloadMessage = download.messages.find(dMessage => dMessage.id == message.discordObject.id);
                if (downloadMessage) {
                    if (excludeMessage && message.discordObject.id === excludeMessage.id) {
                        continue;
                    }
                    const downloadMessageIndex = download.messages.indexOf(downloadMessage);
                    download.messages.splice(downloadMessageIndex, 1);
                    setTimeout(() => message.delete(), delayCount * 1000);
                    delayCount += 1;
                }
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
