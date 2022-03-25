module.exports = (Plugin, Library) => {
    "use strict";

    const {Logger, Patcher, WebpackModules, DiscordModules, DOMTools, PluginUtilities, ContextMenu, Settings} = Library;
    const {SettingPanel, Slider} = Settings;
    const {Dispatcher, React, SelectedChannelStore, SelectedGuildStore} = DiscordModules;

    // Set globals
    const fileCheckMod = WebpackModules.getByProps("anyFileTooLarge", "maxFileSize");
    const fileUploadMod = WebpackModules.getByProps("instantBatchUpload", "upload");

    // Utility modules
    const channelMod = BdApi.findModuleByProps("getChannel", "getMutablePrivateChannels", "hasChannel");
    const messagesMod = BdApi.findModuleByProps("hasCurrentUserSentMessage", "getMessage");
    const guildMod = BdApi.findModuleByProps("getGuild");
    const guildIDMod = BdApi.findModuleByProps("getGuildId");
    const userMod = BdApi.findModuleByProps("getCurrentUser");
    const permissionsMod = BdApi.findModuleByProps("computePermissions");
    const deleteMod = BdApi.findModuleByProps("deleteMessage", "dismissAutomatedMessage");
    const MessageAccessories = WebpackModules.find(mod => mod.MessageAccessories.displayName === "MessageAccessories");
    const Attachment = WebpackModules.find(m => m.default?.displayName === "Attachment");

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

    // Converts a file name into its name and extension
    const convertFilenameToComponents = name => {
        const splitData = name.split(".");
        let reconstructedName = "";
        for (let i = 0; i < splitData.length - 1; i++) {
            reconstructedName += splitData[i];
        }

        return [reconstructedName, splitData[splitData.length - 1]];
    }

    function downloadFiles(download) {
        const https = require("https");
        const os = require("os");
        const fs = require("fs");
        const path = require("path");
        const crypto = require("crypto");
        const id = crypto.randomBytes(16).toString("hex");
        const tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), `dlfc-download-${id}`));

        BdApi.showToast("Downloading files...", {type: "info"});

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
                // Save file to valid directory and open it if required
                BdApi.showToast("File reassembled successfully", {type: "success"});

                DiscordNative.fileManager.saveWithDialog(fs.readFileSync(path.join(tempFolder, `${download.filename}`)), download.filename);

                // Clean up
                fs.rmdirSync(tempFolder, {recursive: true});
            });
        })
        .catch(err => {
            Logger.error(err);
            BdApi.showToast("Failed to download file, please try again later.", {type: "error"});
            fs.rmdirSync(tempFolder, {recursive: true});
        })
    }

    class AttachmentShim extends React.Component {
        constructor(props) {
            super(props);

            this.child = props.children;
            this.attachmentID = props.attachmentData.id;

            this.state = {
                downloadData: null
            }

            this.onNewDownload = this.onNewDownload.bind(this);
        }

        componentDidMount() {
            Dispatcher.subscribe("DLFC_REFRESH_DOWNLOADS", this.onNewDownload);
        }

        componentWillUnmount() {
            Dispatcher.unsubscribe("DLFC_REFRESH_DOWNLOADS", this.onNewDownload);
        }

        onNewDownload(e) {
            // Don't do anything if full download data already received
            if (this.state.downloadData) { return; }

            for (const download of e.downloads) {
                if (download.messages[0].attachmentID === this.attachmentID) {
                    this.setState({downloadData: download});
                    break;
                }
            }
        }

        render() {
            if (this.state.downloadData) {
                return React.createElement(Attachment.default, {
                    filename: this.state.downloadData.filename,
                    url: null,
                    dlfc: true,
                    size: this.state.downloadData.totalSize,
                    onClick: () => { downloadFiles(this.state.downloadData); }
                }, []);
            } else {
                return this.child;
            }
        }
    }

    const defaultSettingsData = {
        deletionDelay: 9,
        uploadDelay: 9,
        uploadBatchSize: 3
    };
    let settings = null;

    const reloadSettings = () => {
        settings = PluginUtilities.loadSettings("SplitLargeFiles", defaultSettingsData);
    };

    // Default values for how long to wait to delete or upload a chunk file
    // Values should be around the time a normal user would take to delete or upload each file
    const validActionDelays = [6, 7, 8, 9, 10, 11, 12];

    // Default values for how many files can be uploaded per upload cycle
    const validUploadBatchSizes = [...Array(11).keys()].slice(1);

    class SplitLargeFiles extends Plugin {
        onStart() {
            BdApi.injectCSS("SplitLargeFiles", `
                .dlfcIcon {
                    width: 30px; 
                    height: 40px; 
                    margin-right: 8px;
                }
            `);

            // Load settings data
            reloadSettings();

            this.registeredDownloads = [];
            this.incompleteDownloads = [];

            /**
             * UPLOAD MODULE
             */

            // Make all file too large checks succeed
            Patcher.instead(fileCheckMod, "anyFileTooLarge", (_, __, ___) => {
                return false;
            });

            Patcher.instead(fileCheckMod, "uploadSumTooLarge", (_, __, ___) => {
                return false;
            })

            Patcher.instead(fileCheckMod, "getUploadFileSizeSum", (_, __, ___) => {
                return 0;
            })
            // Inject flag argument so that this plugin can still get real max size for chunking but anything else gets a really big number
            Patcher.instead(fileCheckMod, "maxFileSize", (_, args, original) => {
                // Must be unwrapped this way otherwise errors occur with undefined unwrapping
                const [arg, use_original] = args;
                if (use_original) {
                    return original(arg);
                }
                return Number.MAX_VALUE;
            });

            // Patch upload call to either pass file unaltered if under limit or chunked if over
            Patcher.instead(fileUploadMod, "upload", (_, args, original) => {
                const [channelId, file, n] = args;
                // Make sure we can upload at all
                if (this.maxFileUploadSize() === 0) {
                    BdApi.showToast("Failed to get max file upload size.", {type: "error"});
                    return;
                }
                // Calculate chunks required
                const [numChunks, numChunksWithHeaders] = this.calcNumChunks(file);
                // Don't do anything if no changes needed
                if (numChunks == 1) {
                    original(...args);
                    return;
                } else if (numChunksWithHeaders > 255) { // Check to make sure the number of files when chunked with header is not greater than 255 otherwise fail
                    BdApi.showToast("File size exceeds max chunk count of 255.", {type: "error"});
                    return;
                }

                BdApi.showToast("Generating file chunks...", {type: "info"});
                this.uploadLargeFiles([file], channelId, n);
            });

            Patcher.instead(fileUploadMod, "uploadFiles", (_, args, original) => {
                const [channelId, files, n, message, stickers] = args;

                // Make sure we can upload at all
                if (this.maxFileUploadSize() === 0) {
                    BdApi.showToast("Failed to get max file upload size.", {type: "error"});
                    return;
                }

                // Iterate over files to see which ones are oversized and move them to an array if they are
                let oversizedFiles = [];
                for (let fIndex = 0; fIndex < files.length; fIndex++) {
                    const file = files[fIndex].item.file;
                    // Calculate chunks required
                    const [numChunks, numChunksWithHeaders] = this.calcNumChunks(file);
                    // Don't do anything if no changes needed
                    if (numChunks == 1) {
                        continue;
                    } else if (numChunksWithHeaders > 255) { // Check to make sure the number of files when chunked with header is not greater than 255 otherwise fail
                        BdApi.showToast("File size exceeds max chunk count of 255.", {type: "error"});
                        return;
                    }

                    // File is oversized, remove it from the array and add it to oversized list
                    files.splice(fIndex, 1);
                    oversizedFiles.push(file);
                    // Adjust index to be consistent with new array positioning
                    fIndex--;
                }

                // Call original function with modified arguments UNLESS there is no other content
                if (files.length > 0 || message.content.length > 0 || stickers.stickerIds.length > 0) {
                    original(channelId, files, n, message, stickers);
                }

                // Use batch uploader for chunk files
                if (oversizedFiles.length > 0) {
                    this.uploadLargeFiles(oversizedFiles, channelId, n, oversizedFiles.length > 1);
                }
            });

            Patcher.after(MessageAccessories.MessageAccessories.prototype, "renderAttachments", (_, [arg], ret) => {
                if (!ret || arg.attachments.length === 0 || !arg.attachments[0].filename.endsWith(".dlfc")) { return; }

                const component = ret[0].props.children;
                ret[0].props.children = (
                    <AttachmentShim attachmentData={arg.attachments[0]}>
                        {component}
                    </AttachmentShim>
                );
            });

            // Adds onClick to download arrow button that for some reason doesn't have it already
            Patcher.after(Attachment, "default", (_, args, ret) => {
                ret.props.children[2].props.onClick = args[0].onClick;
                if (args[0].dlfc) {
                    ret.props.children[0] = React.createElement("img", {
                        className: "dlfcIcon",
                        alt: "Attachment file type: SplitLargeFiles Chunk File", 
                        title: "SplitLargeFiles Chunk File",
                        src: "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9Im5vIj8+CjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+Cjxzdmcgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgdmlld0JveD0iMCAwIDcyIDk2IiB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHhtbDpzcGFjZT0icHJlc2VydmUiIHhtbG5zOnNlcmlmPSJodHRwOi8vd3d3LnNlcmlmLmNvbS8iIHN0eWxlPSJmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtzdHJva2UtbGluZWpvaW46cm91bmQ7c3Ryb2tlLW1pdGVybGltaXQ6MjsiPgogICAgPHBhdGggZD0iTTcyLDI5LjNMNzIsODkuNkM3Miw5MS44NCA3Miw5Mi45NiA3MS41Niw5My44MkM3MS4xOCw5NC41NiA3MC41Niw5NS4xOCA2OS44Miw5NS41NkM2OC45Niw5NiA2Ny44NCw5NiA2NS42LDk2TDYuNCw5NkM0LjE2LDk2IDMuMDQsOTYgMi4xOCw5NS41NkMxLjQ0LDk1LjE4IDAuODIsOTQuNTYgMC40NCw5My44MkMwLDkyLjk2IDAsOTEuODQgMCw4OS42TDAsNi40QzAsNC4xNiAwLDMuMDQgMC40NCwyLjE4QzAuODIsMS40NCAxLjQ0LDAuODIgMi4xOCwwLjQ0QzMuMDQsLTAgNC4xNiwtMCA2LjQsLTBMNDIuNywtMEM0NC42NiwtMCA0NS42NCwtMCA0Ni41NiwwLjIyQzQ3LjA2LDAuMzQgNDcuNTQsMC41IDQ4LDAuNzJMNDgsMTcuNkM0OCwxOS44NCA0OCwyMC45NiA0OC40NCwyMS44MkM0OC44MiwyMi41NiA0OS40NCwyMy4xOCA1MC4xOCwyMy41NkM1MS4wNCwyNCA1Mi4xNiwyNCA1NC40LDI0TDcxLjI4LDI0QzcxLjUsMjQuNDYgNzEuNjYsMjQuOTQgNzEuNzgsMjUuNDRDNzIsMjYuMzYgNzIsMjcuMzQgNzIsMjkuM1oiIHN0eWxlPSJmaWxsOnJnYigyMTEsMjE0LDI1Myk7ZmlsbC1ydWxlOm5vbnplcm87Ii8+CiAgICA8cGF0aCBkPSJNNjguMjYsMjAuMjZDNjkuNjQsMjEuNjQgNzAuMzIsMjIuMzIgNzAuODIsMjMuMTRDNzEsMjMuNDIgNzEuMTQsMjMuNyA3MS4yOCwyNEw1NC40LDI0QzUyLjE2LDI0IDUxLjA0LDI0IDUwLjE4LDIzLjU2QzQ5LjQ0LDIzLjE4IDQ4LjgyLDIyLjU2IDQ4LjQ0LDIxLjgyQzQ4LDIwLjk2IDQ4LDE5Ljg0IDQ4LDE3LjZMNDgsMC43MkM0OC4zLDAuODYgNDguNTgsMSA0OC44NiwxLjE4QzQ5LjY4LDEuNjggNTAuMzYsMi4zNiA1MS43NCwzLjc0TDY4LjI2LDIwLjI2WiIgc3R5bGU9ImZpbGw6cmdiKDE0NywxNTUsMjQ5KTtmaWxsLXJ1bGU6bm9uemVybzsiLz4KICAgIDxnIHRyYW5zZm9ybT0ibWF0cml4KDEsMCwwLDEsNC41LDcpIj4KICAgICAgICA8cmVjdCB4PSIxMSIgeT0iNDEiIHdpZHRoPSI0MSIgaGVpZ2h0PSIyOCIgc3R5bGU9ImZpbGw6cmdiKDE0NywxNTUsMjQ5KTsiLz4KICAgIDwvZz4KICAgIDxnIHRyYW5zZm9ybT0ibWF0cml4KDEsMCwwLDAuNSwtMiwyMy41KSI+CiAgICAgICAgPHJlY3QgeD0iMjEiIHk9IjM5IiB3aWR0aD0iMTAiIGhlaWdodD0iMTAiIHN0eWxlPSJmaWxsOnJnYigxNDcsMTU1LDI0OSk7Ii8+CiAgICA8L2c+CiAgICA8ZyB0cmFuc2Zvcm09Im1hdHJpeCgxLDAsMCwwLjUsMjIsMjMuNSkiPgogICAgICAgIDxyZWN0IHg9IjIxIiB5PSIzOSIgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBzdHlsZT0iZmlsbDpyZ2IoMTQ3LDE1NSwyNDkpOyIvPgogICAgPC9nPgo8L3N2Zz4K"
                    });
                }
            });

            /**
             * RENDER MODULE
             */

            this.messageCreate = e => {
                // Disregard if not in same channel or in process of being sent
                if (e.channelId !== this.getCurrentChannel()?.id) {
                    return;
                }
                this.lastMessageCreatedId = e.message.id;
                this.findAvailableDownloads();
            };

            Dispatcher.subscribe("MESSAGE_CREATE", this.messageCreate);

            this.channelSelect = _ => {
                // Wait a bit to allow DOM to update before refreshing
                setTimeout(() => this.findAvailableDownloads(), 200);
            };

            Dispatcher.subscribe("CHANNEL_SELECT", this.channelSelect);

            // Adds some redundancy for slow network connections
            this.loadMessagesSuccess = _ => {
                this.findAvailableDownloads();
            };

            Dispatcher.subscribe("LOAD_MESSAGES_SUCCESS", this.loadMessagesSuccess);

            // Manual refresh button in both channel and message menus
            ContextMenu.getDiscordMenu("MessageContextMenu").then(menu => {
                Patcher.after(menu, "default", (_, [arg], ret) => {
                    ret.props.children.splice(4, 0, ContextMenu.buildMenuItem({type: "separator"}), ContextMenu.buildMenuItem({label: "Refresh Downloadables", action: () => { 
                        this.findAvailableDownloads();
                        BdApi.showToast("Downloadables refreshed", {type: "success"});
                    }}));
                    const incomplete = this.incompleteDownloads.find(download => download.messages.find(message => message.id === arg.message.id));
                    if (incomplete && this.canDeleteDownload(incomplete)) {
                        ret.props.children.splice(6, 0, ContextMenu.buildMenuItem({label: "Delete Download Fragments", danger: true, action: () => {
                            this.deleteDownload(incomplete);
                            this.findAvailableDownloads();
                        }}));
                    }
                });
            });

            ContextMenu.getDiscordMenu("ChannelListTextChannelContextMenu").then(menu => {
                Patcher.after(menu, "default", (_, [arg], ret) => {
                    if (arg.channel.id === this.getCurrentChannel()?.id) {
                        ret.props.children.props.children.splice(1, 0, ContextMenu.buildMenuItem({type: "separator"}), ContextMenu.buildMenuItem({label: "Refresh Downloadables", action: () => { 
                            this.findAvailableDownloads();
                            BdApi.showToast("Downloadables refreshed", {type: "success"});
                        }}));
                    }
                });
            });

            // TODO: Patch DMUserContextMenu

            // Handle deletion of part of file to delete all other parts either by user or automod
            this.messageDelete = e => {
                // Disregard if not in same channel
                if (e.channelId !== this.getCurrentChannel()?.id) {
                    return;
                }
                const download = this.registeredDownloads.find(element => element.messages.find(message => message.id == e.id));
                if (download && this.canDeleteDownload(download)) {
                    this.deleteDownload(download, e.id);
                }
                this.findAvailableDownloads();
            }

            Dispatcher.subscribe("MESSAGE_DELETE", this.messageDelete);

            /**
             * COMPLETION
             */

            BdApi.showToast("Waiting for BetterDiscord to load before refreshing downloadables...", {type: "info"});
            // Wait for DOM to render before trying to find downloads
            setTimeout(() => {
                BdApi.showToast("Downloadables refreshed", {type: "success"});
                this.findAvailableDownloads()
            }, 10000);
        }

        // Splits and uploads a large file
        // Batch uploading should be disabled when multiple files need to be uploaded to prevent API spam
        uploadLargeFiles(files, channelId, n, disableBatch=false) {
            BdApi.showToast("Generating file chunks...", {type: "info"});
            const batchSize = disableBatch ? 1 : settings.uploadBatchSize;
            
            for (const file of files) {
                // Convert file to bytes
                file.arrayBuffer().then(buffer => {
                    const fileBytes = new Uint8Array(buffer);

                    // Calculate chunks required
                    const [numChunks, numChunksWithHeaders] = this.calcNumChunks(file);

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

                    // Upload through built-in batch system
                    for (let i = 0; i < Math.ceil(fileList.length / batchSize); ++i) {
                        setTimeout(() => fileUploadMod.instantBatchUpload(channelId, fileList.slice(i * batchSize, i * batchSize + batchSize), n), settings.uploadDelay * i * 1000);
                    }
                }).catch(err => {
                    Logger.error(err);
                    BdApi.showToast("Failed to read file, please try again later.", {type: "error"})
                });
            }

            BdApi.showToast(`All files uploading (${batchSize} chunk${batchSize == 1 ? "" : "s"}/${settings.uploadDelay} seconds${disableBatch ? ", batch disabled" : ""})`, {type: "success"});
        }

        // Returns numChunks and numChunksWithHeaders
        calcNumChunks(file) {
            return [Math.ceil(file.size / this.maxFileUploadSize()), Math.ceil(file.size / (this.maxFileUploadSize() - 4))]
        }

        // Create the settings panel
        getSettingsPanel() {
            reloadSettings();
            return new SettingPanel(() => { PluginUtilities.saveSettings("SplitLargeFiles", settings); }, 
                new Slider("Chunk File Upload Batch Size", "Number of chunk files to queue per upload operation." + 
                    " Setting this higher uploads your files faster but increases the chance of upload errors.", 
                    validUploadBatchSizes[0], validUploadBatchSizes[validUploadBatchSizes.length - 1], settings.uploadBatchSize, newVal => {
                        // Make sure value is in bounds
                        if (newVal > validUploadBatchSizes[validUploadBatchSizes.length - 1] || newVal < validUploadBatchSizes[0]) {
                            newVal = validUploadBatchSizes[0];
                        }
                        settings.uploadBatchSize = newVal;
                    }, {markers: validUploadBatchSizes, stickToMarkers: true}),

                new Slider("Chunk File Upload Delay", "How long to wait (in seconds) before uploading each chunk file batch." + 
                    " If you plan on uploading VERY large files you should set this value high to avoid API spam.",
                    validActionDelays[0], validActionDelays[validActionDelays.length - 1], settings.uploadDelay, newVal => {
                        // Make sure value is in bounds
                        if (newVal > validActionDelays[validActionDelays.length - 1] || newVal < validActionDelays[0]) {
                            newVal = validActionDelays[0];
                        }
                        settings.uploadDelay = newVal;
                    }, {markers: validActionDelays, stickToMarkers: true}),

                new Slider("Chunk File Deletion Delay", "How long to wait (in seconds) before deleting each sequential message of a chunk file." + 
                    " If you plan on deleting VERY large files you should set this value high to avoid API spam.", 
                    validActionDelays[0], validActionDelays[validActionDelays.length - 1], settings.deletionDelay, newVal => {
                        // Make sure value is in bounds
                        if (newVal > validActionDelays[validActionDelays.length - 1] || newVal < validActionDelays[0]) {
                            newVal = validActionDelays[0];
                        }
                        settings.deletionDelay = newVal;
                    }, {markers: validActionDelays, stickToMarkers: true})
            ).getElement();
        }

        // Gets the maximum file upload size for the current server
        maxFileUploadSize() {
            if (!fileCheckMod) {
                return 0;
            }

            // Built-in buffer, otherwise file upload fails
            return fileCheckMod.maxFileSize(SelectedGuildStore.getGuildId(), true) - 1000;
        }

        // Looks through current messages to see which ones have (supposedly) complete .dlfc files and make a list of them
        // We are unable to completely verify the integrity of the files without downloading them and checking their headers
        // Checks messages sequentially and will tag messages at the top that don't have complete downloads available for further warnings
        findAvailableDownloads() {
            this.registeredDownloads = [];
            this.incompleteDownloads = [];
            
            for (const message of this.getChannelMessages(this.getCurrentChannel()?.id) ?? []) {
                // If object already searched with nothing then skip
                if (message.noDLFC) {
                    continue;
                }

                // Check for DLFC files
                let foundDLFCAttachment = false;
                for (const attachment of message.attachments) {
                    // Make sure file (somewhat) follows correct format, if not then skip
                    if (isNaN(parseInt(attachment.filename)) || !attachment.filename.endsWith(".dlfc")) {
                        continue;
                    }
                    foundDLFCAttachment = true;
                    const realName = this.extractRealFileName(attachment.filename);
                    // Finds the first (latest) entry that has the name that doesn't already have a part of the same index
                    const existingEntry = this.registeredDownloads.find(element => element.filename === realName && !element.foundParts.has(parseInt(attachment.filename)));
                    if (existingEntry) {
                        // Add to existing entry if found
                        existingEntry.urls.push(attachment.url);
                        existingEntry.messages.push({id: message.id, date: message.timestamp, attachmentID: attachment.id});
                        existingEntry.foundParts.add(parseInt(attachment.filename));
                        existingEntry.totalSize += attachment.size;
                    } else {
                        // Create new download
                        this.registeredDownloads.unshift({
                            filename: realName,
                            owner: message.author.id,
                            urls: [attachment.url],
                            messages: [{id: message.id, date: message.timestamp, attachmentID: attachment.id}],
                            foundParts: new Set([parseInt(attachment.filename)]),
                            totalSize: attachment.size
                        });
                    }
                }

                // Tag object if no attachments found to prevent unneeded repeat scans
                if (!foundDLFCAttachment) {
                    message.noDLFC = true;
                }
            }

            // Filter downloads that aren't contiguous
            this.registeredDownloads = this.registeredDownloads.filter((value, _, __) => {
                const chunkSet = new Set();
                let highestChunk = 0;
                for (const url of value.urls) {
                    // Extract file data from URL and add it to check vars
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

                // Make sure all number parts are present and the highest chunk + 1 is equal to the size (zero indexing)
                const result = isSetLinear(chunkSet) && highestChunk + 1 === chunkSet.size;
                if (!result) {
                    // Add to incomplete download register if failed
                    this.incompleteDownloads.push(value);
                }
                return result;
            });

            // Iterate over remaining downloads and hide all messages except for the one sent first
            this.registeredDownloads.forEach(download => {
                download.messages.sort((first, second) => first.date - second.date);
                // Rename first message to real file name
                // this.formatFirstDownloadMessage(download.messages[0].id, download);

                // Hide the rest of the messages
                for (let messageIndex = 1; messageIndex < download.messages.length; messageIndex++) {
                    this.setMessageVisibility(download.messages[messageIndex].id, false);
                }
            });

            if (this.registeredDownloads.length > 0) {
                Dispatcher.dirtyDispatch({
                    type: "DLFC_REFRESH_DOWNLOADS",
                    downloads: this.registeredDownloads
                });
            }
        }

        // Extracts the original file name from the wrapper
        extractRealFileName(name) {
            return name.slice(name.indexOf("_") + 1, name.length - 5);
        }

        // Shows/hides a message with a certain ID
        setMessageVisibility(id, visible) {
            const element = DOMTools.query(`#chat-messages-${id}`);
            if (element) {
                if (visible) {
                    element.removeAttribute("hidden");
                } else {
                    element.setAttribute("hidden", "");
                }
            } else {
                Logger.error(`Unable to find DOM object with selector #chat-messages-${id}`);
            }
        }

        // Deletes a download with a delay to make sure Discord's API isn't spammed
        // Excludes a message that was already deleted
        deleteDownload(download, excludeMessage = null) {
            BdApi.showToast(`Deleting chunks (1 chunk/${settings.deletionDelay} seconds)`, {type: "success"});
            let delayCount = 1;
            for (const message of this.getChannelMessages(this.getCurrentChannel().id)) {
                const downloadMessage = download.messages.find(dMessage => dMessage.id == message.id);
                if (downloadMessage) {
                    if (excludeMessage && message.id === excludeMessage.id) {
                        continue;
                    }
                    this.setMessageVisibility(message.id, true);
                    const downloadMessageIndex = download.messages.indexOf(downloadMessage);
                    download.messages.splice(downloadMessageIndex, 1);
                    setTimeout(() => this.deleteMessage(message), delayCount * settings.deletionDelay * 1000);
                    delayCount += 1;
                }
            }
        }

        canDeleteDownload(download) {
            return download.owner === this.getCurrentUser().id || this.canManageMessages();
        }

        getCurrentChannel() {
            return channelMod.getChannel(SelectedChannelStore.getChannelId()) ?? null;
        }

        getChannelMessages(channelId) {
            if (!channelId) {
                return null;
            }
            return messagesMod.getMessages(channelId)._array;
        }

        getCurrentUser() {
            return userMod.getCurrentUser();
        }

        canManageMessages() {
            const currentChannel = this.getCurrentChannel();
            if (!currentChannel) {
                return false;
            }
            // Convert permissions big int into bool using falsy coercion
            return !!(permissionsMod.computePermissions(currentChannel) & 0x2000n);
        }

        deleteMessage(message) {
            deleteMod.deleteMessage(message.channel_id, message.id, false);
        }

        onStop() {
            Patcher.unpatchAll();
            Dispatcher.unsubscribe("MESSAGE_CREATE", this.messageCreate);
            Dispatcher.unsubscribe("CHANNEL_SELECT", this.channelSelect);
            Dispatcher.unsubscribe("MESSAGE_DELETE", this.messageDelete);
            Dispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", this.loadMessagesSuccess);
            BdApi.clearCSS("SplitLargeFiles");
        }
    };

    return SplitLargeFiles;
}
