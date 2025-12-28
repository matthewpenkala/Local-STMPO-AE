/*
STMPO Local Runner — Hybrid (UI: v2.2.0, Logic: v2.3.0+)
--------------------------------------------------------
Architect: Matthew Penkala
Assistant: merge + hardening
Version: 2.4.3 (v8)

Goal:
- Keep the clean, simple, integrated UI/flow from STMPOLocalRunner.jsx (v2.2.x)
- Keep the rewritten runner command logic + advanced controllability from Cockpit v2.3.x

Notes:
- Local debug runner for segmented aerender via Python `stmpo_local_render.py`
- No Deadline Cloud
- OS-agnostic (Win/macOS)
- Can parse QUEUED items from AE Render Queue and apply output + frame range

Install (dockable panel):
- Place in: Scripts/ScriptUI Panels/
- Restart After Effects
*/

#target aftereffects

(function (thisObj) {

    // =========================================================================
    // Utils
    // =========================================================================
    var Utils = {};

    Utils.isWindows = function () { return $.os.indexOf("Windows") !== -1; };
    Utils.isMac = function () { return $.os.indexOf("Mac") !== -1; };

    Utils.trim = function (s) {
        if (s === null || s === undefined) return "";
        return ("" + s).replace(/^\s+|\s+$/g, "");
    };

    Utils.safeParseJSON = function (s) {
        try { return JSON.parse(s); } catch (e) { return null; }
    };

    Utils.safeStringifyJSON = function (o) {
        try { return JSON.stringify(o, null, 2); } catch (e) { return "{}"; }
    };

    Utils.ensureFolder = function (folderObjOrPath) {
        try {
            var f = (folderObjOrPath instanceof Folder) ? folderObjOrPath : new Folder(folderObjOrPath);
            if (!f.exists) f.create();
            return true;
        } catch (e) { return false; }
    };

Utils.copyFile = function (srcPath, dstPath) {
    try {
        var src = (srcPath instanceof File) ? srcPath : new File(srcPath);
        if (!src.exists) return false;
        var dst = (dstPath instanceof File) ? dstPath : new File(dstPath);
        Utils.ensureFolder(dst.parent);
        if (dst.exists) { try { dst.remove(); } catch (eRm) {} }
        return src.copy(dst.fsName);
    } catch (e) {
        return false;
    }
};

Utils.copyFolderRecursive = function (srcFolderPath, dstFolderPath) {
    try {
        var src = (srcFolderPath instanceof Folder) ? srcFolderPath : new Folder(srcFolderPath);
        if (!src.exists) return false;
        var dst = (dstFolderPath instanceof Folder) ? dstFolderPath : new Folder(dstFolderPath);
        Utils.ensureFolder(dst);

        var items = src.getFiles();
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it instanceof Folder) {
                Utils.copyFolderRecursive(it.fsName, dst.fsName + "/" + it.name);
            } else {
                Utils.copyFile(it.fsName, dst.fsName + "/" + it.name);
            }
        }
        return true;
    } catch (e) {
        return false;
    }
};

// Recursively deletes a File or Folder tree.
// NOTE: Folder.remove() only works on empty folders, so we must clear children first.
Utils.removeTree = function (fileOrFolder) {
    try {
        var f = fileOrFolder;
        if (!f) return true;
        if (!f.exists) return true;

        if (f instanceof File) {
            return f.remove();
        }

        if (f instanceof Folder) {
            var kids = f.getFiles();
            for (var i = 0; i < kids.length; i++) {
                Utils.removeTree(kids[i]);
            }
            return f.remove();
        }
        return false;
    } catch (e) {
        return false;
    }
};

    Utils.readFile = function (fileObjOrPath) {
        try {
            var f = (fileObjOrPath instanceof File) ? fileObjOrPath : new File(fileObjOrPath);
            if (!f || !f.exists) return null;
            f.encoding = "UTF-8";
            if (!f.open("r")) return null;
            var s = f.read();
            f.close();
            return s;
        } catch (e) {
            try { if (f && f.opened) f.close(); } catch (e2) {}
            return null;
        }
    };

    // Read the last N bytes of a text file (best-effort) without loading the whole file.
    Utils.readFileTail = function (fileObjOrPath, maxBytes) {
        var f = null;
        try {
            maxBytes = maxBytes || (64 * 1024);
            f = (fileObjOrPath instanceof File) ? fileObjOrPath : new File(fileObjOrPath);
            if (!f || !f.exists) return "";
            f.encoding = "UTF-8";
            if (!f.open("r")) return "";
            var len = 0;
            try { len = f.length || 0; } catch (eLen) { len = 0; }
            var start = Math.max(0, len - maxBytes);
            try { f.seek(start, 0); } catch (eSeek) {
                // Some ExtendScript hosts don't support seek; fall back to full read.
                start = 0;
            }
            var s = f.read();
            f.close();

            // If we started in the middle, drop the first partial line.
            if (start > 0) {
                var nl = s.indexOf("\n");
                if (nl >= 0) s = s.substring(nl + 1);
            }
            return s || "";
        } catch (e) {
            try { if (f && f.opened) f.close(); } catch (e2) {}
            return "";
        }
    };

    Utils.revealInOS = function (path) {
        try {
            if (!path) return;
            if (Utils.isWindows()) {
                system.callSystem('explorer.exe /select,' + Utils.q(path));
            } else {
                system.callSystem('open -R ' + Utils.q(path));
            }
        } catch (e) {}
    };

    Utils.writeFile = function (fileObjOrPath, content) {
        try {
            var f = (fileObjOrPath instanceof File) ? fileObjOrPath : new File(fileObjOrPath);
            if (!f) return false;
            if (f.parent) Utils.ensureFolder(f.parent);
            f.encoding = "UTF-8";
            if (!f.open("w")) return false;
            f.write(content);
            f.close();
            return true;
        } catch (e) {
            try { if (f && f.opened) f.close(); } catch (e2) {}
            return false;
        }
    };

    Utils.fileExists = function (path) {
        try { var f = new File(path); return !!(f && f.exists); } catch (e) { return false; }
    };

    Utils.truncateMiddle = function (s, maxLen) {
        s = s || "";
        if (s.length <= maxLen) return s;
        var keep = Math.max(10, Math.floor((maxLen - 3) / 2));
        return s.substr(0, keep) + "..." + s.substr(s.length - keep);
    };

    // Quote a path/arg for shell usage (best-effort)
    Utils.q = function (s) {
        s = (s === null || s === undefined) ? "" : ("" + s);
        s = s.replace(/"/g, '\\"');
        return '"' + s + '"';
    };

    Utils.openInOS = function (path) {
        try {
            if (!path) return;
            if (Utils.isWindows()) {
                system.callSystem('cmd.exe /c start "" ' + Utils.q(path));
            } else {
                system.callSystem('open ' + Utils.q(path));
            }
        } catch (e) {}
    };

    Utils.alertLong = function (title, text) {
        var w = new Window("dialog", title);
        w.alignChildren = ["fill", "top"];
        var et = w.add("edittext", undefined, text || "", { multiline: true, scrolling: true });
        et.preferredSize = [760, 420];
        var g = w.add("group");
        g.alignment = "right";
        g.add("button", undefined, "Close", { name: "ok" });
        w.show();
    };

    // Detect a Python 3 interpreter command on the current system.
    // - If python_path points to an existing file, that path is used (quoted).
    // - If python_path is non-empty but not a file, it is treated as a command and validated.
    // - Otherwise we probe common candidates and validate that they report Python 3.x.
    // On Windows, we prefer the Python launcher (`py -3`) when available.
    Utils.detectPython3Command = function (pythonPathOrCmd) {

        function probe(cmd) {
            if (!cmd) return false;
            var test = cmd + " --version";
            var out = "";
            try {
                if (Utils.isWindows()) {
                    out = system.callSystem('cmd.exe /c ' + test + ' 2>&1');
                } else {
                    out = system.callSystem('/bin/bash -lc ' + Utils.q(test + ' 2>&1'));
                }
            } catch (e) {
                return false;
            }

            out = Utils.trim(out);

            // Common Windows Store alias/stub messages
            if (out.indexOf("Microsoft Store") !== -1) return false;
            if (out.indexOf("Windows Store") !== -1) return false;

            return (out.indexOf("Python 3") === 0);
        }

        var raw = Utils.trim(pythonPathOrCmd);

        // Explicit path
        if (raw) {
            if (Utils.fileExists(raw)) {
                try { return Utils.q((new File(raw)).fsName); } catch (e0) { return Utils.q(raw); }
            }
            // Explicit command (e.g. "py -3", "python3")
            if (probe(raw)) return raw;
        }

        var candidates = Utils.isWindows() ? ["py -3", "python3", "python"] : ["python3", "python"];
        for (var i = 0; i < candidates.length; i++) {
            if (probe(candidates[i])) return candidates[i];
        }

        return null;
    };


    // =========================================================================
    // After Effects discovery (auto-fills aerender/AE dir based on the CURRENT running AE)
    // =========================================================================
    Utils.getAEMajorVersion = function () {
        try {
            var v = (app && app.version) ? ("" + app.version) : "";
            var m = /(\d+)\./.exec(v);
            return m ? parseInt(m[1], 10) : null;
        } catch (e) { return null; }
    };

    Utils.detectAEInstall = function () {
        // Returns { aerender_path: "...", after_effects_dir: "..." } or null.
        var major = Utils.getAEMajorVersion();
        var year = (major !== null && !isNaN(major)) ? (2000 + major) : null;

        var cands = [];

        // 1) Current AE major version (preferred)
        if (Utils.isMac() && year) {
            cands.push({ dir: "/Applications/Adobe After Effects " + year, aer: "/Applications/Adobe After Effects " + year + "/aerender" });
            cands.push({ dir: "/Applications/After Effects " + year, aer: "/Applications/After Effects " + year + "/aerender" });
        } else if (Utils.isWindows() && year) {
            var pf = $.getenv("ProgramW6432") || $.getenv("ProgramFiles") || "C:\\Program Files";
            var pf86 = $.getenv("ProgramFiles(x86)") || "C:\\Program Files (x86)";
            cands.push({ dir: pf + "\\Adobe\\Adobe After Effects " + year, aer: pf + "\\Adobe\\Adobe After Effects " + year + "\\Support Files\\aerender.exe" });
            cands.push({ dir: pf86 + "\\Adobe\\Adobe After Effects " + year, aer: pf86 + "\\Adobe\\Adobe After Effects " + year + "\\Support Files\\aerender.exe" });
        }

        // 2) app.path-derived guesses (secondary)
        try {
            if (app && app.path) {
                var p = app.path.fsName;
                if (Utils.isWindows()) {
                    cands.push({ dir: p, aer: p + "\\aerender.exe" });
                    cands.push({ dir: p, aer: p + "\\aerender" });
                    try { cands.push({ dir: (new Folder(p)).parent.fsName, aer: (new Folder(p)).parent.fsName + "\\aerender.exe" }); } catch (eP0) {}
                } else {
                    cands.push({ dir: p, aer: p + "/aerender" });
                    try { cands.push({ dir: (new Folder(p)).parent.fsName, aer: (new Folder(p)).parent.fsName + "/aerender" }); } catch (eP1) {}
                    try { cands.push({ dir: (new Folder(p)).parent.parent.fsName, aer: (new Folder(p)).parent.parent.fsName + "/aerender" }); } catch (eP2) {}
                }
            }
        } catch (e0) {}

        // 3) macOS: scan /Applications and prefer matching year, else newest
        if (Utils.isMac()) {
            try {
                var apps = new Folder("/Applications");
                if (apps.exists) {
                    var folders = apps.getFiles(function (f) {
                        try { return (f instanceof Folder) && /^Adobe After Effects \d{4}$/.test(f.name); } catch (e) { return false; }
                    });

                    var best = null;
                    var bestYear = -1;
                    var match = null;

                    for (var i = 0; i < folders.length; i++) {
                        var fd = folders[i];
                        var y = parseInt(fd.name.replace("Adobe After Effects ", ""), 10);
                        if (isNaN(y)) continue;

                        var aer = new File(fd.fsName + "/aerender");
                        if (!aer.exists) continue;

                        if (year && y === year) {
                            match = { dir: fd.fsName, aer: aer.fsName };
                            break;
                        }
                        if (y > bestYear) {
                            bestYear = y;
                            best = { dir: fd.fsName, aer: aer.fsName };
                        }
                    }

                    if (match) cands.unshift(match);
                    else if (best) cands.push(best);
                }
            } catch (e1) {}
        }

        // Validate & return first existing aerender
        for (var j = 0; j < cands.length; j++) {
            try {
                var cand = cands[j];
                if (!cand || !cand.aer) continue;
                var f = new File(cand.aer);
                if (!f.exists) continue;

                var out = {};
                out.aerender_path = f.fsName;

                if (cand.dir) {
                    var d = new Folder(cand.dir);
                    if (d.exists) out.after_effects_dir = d.fsName;
                }
                return out;
            } catch (e2) {}
        }

        return null;
    };

    Utils.autofillAEPathsIfMissing = function (state) {
        // Only fills missing/invalid fields so user overrides remain respected.
        try {
            if (!state) return false;

            var needAer = !Utils.trim(state.aerender_path) || !Utils.fileExists(state.aerender_path);
            var needDir = !Utils.trim(state.after_effects_dir);

            if (!needAer && !needDir) return false;

            var found = Utils.detectAEInstall();
            if (!found) return false;

            if (needAer && found.aerender_path) state.aerender_path = found.aerender_path;
            if (needDir && found.after_effects_dir) state.after_effects_dir = found.after_effects_dir;

            return true;
        } catch (e) { return false; }
    };

    // =========================================================================
    // Model
    // =========================================================================
    function STMPO_Model() {
        this.prefsFolder = new Folder(Folder.userData.fsName + "/STMPO_LocalRunner");
        this.prefsFile = new File(this.prefsFolder.fsName + "/prefs_v240.json");
        // Read-only fallback sources for migration
        this.prefsFile_v2 = new File(this.prefsFolder.fsName + "/prefs_v2.json");
        this.prefsFile_v230 = new File(this.prefsFolder.fsName + "/prefs_v230.json");
        this.logFile = new File(this.prefsFolder.fsName + "/last_run.log");
        this.pidFile = new File(this.prefsFolder.fsName + "/runner_pid.txt");

        this.state = {
            // Context
            project_path: "",
            output_path: "",

            // Target
            target_mode: "comp", // "comp" | "rqindex"
            comp_name: "",
            rq_index: "1",

            // Templates (optional)
            rs_template: "",
            om_template: "",
            use_templates: false, // power-user: set true in prefs to force templates


            // Audio
            sound: "ON", // aerender -sound ON|OFF

            // Frames / Scope
            frames_mode: "framespec", // "framespec" | "startend"
            framespec: "1-100",
            start: "",
            end: "",
            chunk_size: "",
            chunk_index: "",

            // Performance
            concurrency_mode: "auto", // "auto" | "fixed"
            max_concurrency: "12",
            ram_per_process_gb: "16",
            disable_mfr: true,

            // System / Paths
            runner_path: "",
            python_path: "",       // optional path OR command (py -3 / python3 / ...)
            aerender_path: "",
            after_effects_dir: "", // optional
            scratch_root: "",
            env_file: "",          // optional

            // Scratch / staging
            no_scratch: false,
            stage_project: true,

            // Orchestrator behavior
            spawn_delay: "2.0",
            child_grace_sec: "10.0",
            kill_on_fail: false,

            // Modes
            mode_dry_run: false,
            mode_background: true,

            // Render Queue helper
            rq_only_queued: true
        };
    }

    STMPO_Model.prototype._applyLoadedObject = function (obj) {
        if (!obj) return;
        var s = this.state;
        for (var k in obj) {
            if (!obj.hasOwnProperty(k)) continue;
            if (s.hasOwnProperty(k)) {
                s[k] = obj[k];
                continue;
            }

            // Migration aliases (v2.3.x)
            if (k === "dry_run") s.mode_dry_run = !!obj[k];
            if (k === "background") s.mode_background = !!obj[k];
        }
    };

    STMPO_Model.prototype.load = function () {
        // Try new prefs first; otherwise migrate from older ones.
        var raw = null;
        var obj = null;

        raw = Utils.readFile(this.prefsFile);
        obj = raw ? Utils.safeParseJSON(raw) : null;

        if (!obj) {
            raw = Utils.readFile(this.prefsFile_v230);
            obj = raw ? Utils.safeParseJSON(raw) : null;
        }

        if (!obj) {
            raw = Utils.readFile(this.prefsFile_v2);
            obj = raw ? Utils.safeParseJSON(raw) : null;
        }

        this._applyLoadedObject(obj);

        // Safety: hidden template overrides have caused unexpected codec changes in aerender.
        // Default to using the Render Queue item's settings unless the user explicitly re-enables overrides.
        this.state.rs_template = "";
        this.state.om_template = "";

        // Prefer the runner bundled alongside this panel (keeps UI + Python code in sync).
        this.findRunnerNearScript();

        // Auto-detect current project if empty
        try {
            if (!this.state.project_path && app.project && app.project.file) {
                this.state.project_path = app.project.file.fsName;
            }
        } catch (e0) {}

        // Try to locate runner if empty
        if (!this.state.runner_path) {
            this.findRunnerNearScript();
        }
    };

    STMPO_Model.prototype.save = function () {
        Utils.ensureFolder(this.prefsFolder);
        Utils.writeFile(this.prefsFile, Utils.safeStringifyJSON(this.state));
    };

    STMPO_Model.prototype.findRunnerNearScript = function () {
        var base = null;
        try { base = (new File($.fileName)).parent; } catch (e) { base = null; }
        if (!base) return;

        var candidates = [
            "stmpo_local_render.py",
            "../stmpo_local_render.py",
            "../STMPO_Local_AE_Debug/stmpo_local_render.py",
            "STMPO_Local_AE_Debug/stmpo_local_render.py"
        ];

        for (var i = 0; i < candidates.length; i++) {
            var f = new File(base.fsName + "/" + candidates[i]);
            if (f.exists) {
                this.state.runner_path = f.fsName;
                return;
            }
        }
    };

STMPO_Model.prototype.installOrUpdateRunnerFromBundle = function () {
    // Copies the Python runner + package that ship alongside this .jsx into the prefs folder,
    // so the UI and Python code stay in sync. Uses a temp staging folder so partial installs
    // don’t leave the prefs folder in a mixed state.
    try {
        var scriptFolder = new File($.fileName).parent;
        var srcRunner = new File(scriptFolder.fsName + "/stmpo_local_render.py");
        var srcPkg = new Folder(scriptFolder.fsName + "/stmpo");

        if (!srcRunner.exists || !srcPkg.exists) {
            return false;
        }

        Utils.ensureFolder(this.prefsFolder);

        var dstRunner = new File(this.prefsFolder.fsName + "/stmpo_local_render.py");
        var dstPkg = new Folder(this.prefsFolder.fsName + "/stmpo");

        var stamp = (new Date()).getTime();
        var tmpRoot = new Folder(this.prefsFolder.fsName + "/__stmpo_install_tmp_" + stamp);

        // Fresh temp root
        try { Utils.removeTree(tmpRoot); } catch (e0) {}
        Utils.ensureFolder(tmpRoot);

        // Stage
        var okStageRunner = Utils.copyFile(srcRunner, tmpRoot.fsName + "/stmpo_local_render.py");
        var okStagePkg = Utils.copyFolderRecursive(srcPkg, tmpRoot.fsName + "/stmpo");

        if (!okStageRunner || !okStagePkg) {
            try { Utils.removeTree(tmpRoot); } catch (e1) {}
            return false;
        }

        // Move old aside (best-effort), but delete after successful install.
        var oldRunner = null;
        var oldPkg = null;

        try {
            if (dstRunner.exists) {
                var oldRunnerName = "stmpo_local_render.py__old__" + stamp;
                dstRunner.rename(oldRunnerName);
                oldRunner = new File(this.prefsFolder.fsName + "/" + oldRunnerName);
            }
        } catch (e2) {
            try { Utils.removeTree(dstRunner); } catch (e3) {}
        }

        try {
            if (dstPkg.exists) {
                var oldPkgName = "stmpo__old__" + stamp;
                dstPkg.rename(oldPkgName);
                oldPkg = new Folder(this.prefsFolder.fsName + "/" + oldPkgName);
            }
        } catch (e4) {
            try { Utils.removeTree(dstPkg); } catch (e5) {}
        }

        // Install into final locations
        var okRunner = Utils.copyFile(tmpRoot.fsName + "/stmpo_local_render.py", dstRunner.fsName);
        var okPkg = Utils.copyFolderRecursive(tmpRoot.fsName + "/stmpo", dstPkg.fsName);

        // Cleanup temp
        try { Utils.removeTree(tmpRoot); } catch (e6) {}

        if (okRunner && okPkg) {
            // Best-effort cleanup of backups
            try { if (oldRunner && oldRunner.exists) oldRunner.remove(); } catch (e7) {}
            try { if (oldPkg && oldPkg.exists) Utils.removeTree(oldPkg); } catch (e8) {}

            this.state.runner_path = dstRunner.fsName;
            this.save();
            return true;
        }

        return false;
    } catch (e) {
        return false;
    }
};


    // -------------------------------------------------------------------------
    // Render Queue parsing (Queued items + timespan -> display frames)
    // -------------------------------------------------------------------------
    STMPO_Model.prototype._statusName = function (st) {
        try {
            if (st === RQItemStatus.WILL_CONTINUE) return "PAUSED";
            if (st === RQItemStatus.NEEDS_OUTPUT) return "NEEDS_OUTPUT";
            if (st === RQItemStatus.UNQUEUED) return "UNQUEUED";
            if (st === RQItemStatus.QUEUED) return "QUEUED";
            if (st === RQItemStatus.RENDERING) return "RENDERING";
            if (st === RQItemStatus.USER_STOPPED) return "USER_STOPPED";
            if (st === RQItemStatus.ERR_STOPPED) return "ERR_STOPPED";
            if (st === RQItemStatus.DONE) return "DONE";
        } catch (e) {}
        return "UNKNOWN";
    };

    STMPO_Model.prototype.getRenderQueueRows = function (onlyQueued) {
        var rows = [];
        try {
            if (!app.project || !app.project.renderQueue) return rows;
            var rq = app.project.renderQueue;
            var n = rq.numItems || 0;

            for (var i = 1; i <= n; i++) {
                var item = null;
                try { item = rq.item(i); } catch (e0) { item = null; }
                if (!item) continue;

                var st = item.status;
                if (onlyQueued && st !== RQItemStatus.QUEUED) continue;

                var compName = "";
                var outPath = "";
                var tsStart = 0;
                var tsDur = 0;

                try { if (item.comp) compName = item.comp.name; } catch (e1) {}
                try {
                    var om = item.outputModule(1);
                    if (om && om.file) outPath = om.file.fsName;
                } catch (e2) {}
                try {
                    tsStart = item.timeSpanStart;
                    tsDur = item.timeSpanDuration;
                } catch (e3) {}

                rows.push({
                    rqIndex: i,
                    status: st,
                    statusName: this._statusName(st),
                    compName: compName,
                    outPath: outPath,
                    timeSpanStart: tsStart,
                    timeSpanDuration: tsDur
                });
            }
        } catch (eOuter) {}
        return rows;
    };

    STMPO_Model.prototype._computeFrameRangeFromRQ = function (row) {
        // Computes inclusive start/end frame in *display* frame numbers if possible.
        // Uses CompItem.displayStartFrame when available; otherwise falls back to displayStartTime.
        try {
            if (!app.project || !app.project.renderQueue) return null;
            var rqItem = app.project.renderQueue.item(row.rqIndex);
            if (!rqItem || !rqItem.comp) return null;

            var comp = rqItem.comp;
            var fd = comp.frameDuration;
            if (!fd || fd <= 0) return null;

            var displayStartFrame = null;
            try {
                if (comp.displayStartFrame !== undefined && comp.displayStartFrame !== null) {
                    displayStartFrame = comp.displayStartFrame;
                }
            } catch (e0) { displayStartFrame = null; }

            if (displayStartFrame === null) {
                var dst = 0;
                try { dst = comp.displayStartTime || 0; } catch (e1) { dst = 0; }
                displayStartFrame = Math.round(dst / fd);
            }

            var t0 = row.timeSpanStart || 0;
            var t1 = (row.timeSpanStart || 0) + (row.timeSpanDuration || 0);

            // End time is exclusive; convert to inclusive frame.
            var startOff = Math.floor((t0 / fd) + 1e-9);
            var endOffExclusive = Math.floor((t1 / fd) + 1e-9);
            var endOff = Math.max(startOff, endOffExclusive - 1);

            return {
                start: displayStartFrame + startOff,
                end: displayStartFrame + endOff
            };
        } catch (e2) {
            return null;
        }
    };

    STMPO_Model.prototype.applyRenderQueueSelection = function (rqIndex) {
        var s = this.state;
        s.target_mode = "rqindex";
        s.rq_index = "" + rqIndex;

        try {
            var item = app.project.renderQueue.item(rqIndex);
            if (!item) return;

            try {
                var om = item.outputModule(1);
                if (om && om.file) s.output_path = om.file.fsName;
                // Capture the actual Output Module template name currently applied.
                /* try { if (om && om.name) s.om_template = String(om.name); } catch (eOmName) {} */
            // disabled: use RQ settings by default
            } catch (e0) {}

            // Capture the current Render Settings template name if available.
            /* try { if (item && item.renderSettings) s.rs_template = String(item.renderSettings); } catch (eRsName) {} */
            // disabled: use RQ settings by default

            var row = {
                rqIndex: rqIndex,
                timeSpanStart: item.timeSpanStart,
                timeSpanDuration: item.timeSpanDuration
            };

            var fr = this._computeFrameRangeFromRQ(row);
            if (fr) {
                s.frames_mode = "framespec";
                s.framespec = fr.start + "-" + fr.end;
            }
        } catch (e1) {}
    };

    // -------------------------------------------------------------------------
    // Command build (Cockpit v2.3.x logic + Python 3 detection)
    // -------------------------------------------------------------------------
    STMPO_Model.prototype.buildCommand = function () {
        var s = this.state;

        var py = Utils.detectPython3Command(s.python_path);
        if (!py) return null;

        var runner = Utils.q(s.runner_path);

        // Ensure prefs folder exists; pass log file to python
        Utils.ensureFolder(this.prefsFolder);
        var logPath = this.logFile.fsName;

        var args = [];

        // Required
        args.push("--project", Utils.q(s.project_path));
        args.push("--output", Utils.q(s.output_path));
        args.push("--log_file", Utils.q(logPath));
        // Write runner PID to disk so the ScriptUI console can pause/stop reliably.
        args.push("--pid_file", Utils.q(this.pidFile.fsName));

        // Audio
        if (Utils.trim(s.sound)) args.push("--sound", Utils.trim(s.sound));

        // Target
        if (s.target_mode === "comp") {
            args.push("--comp", Utils.q(s.comp_name));
        } else {
            args.push("--rqindex", Utils.trim(s.rq_index));
        }
        // Templates (hidden in UI; off by default to respect the project's Render Queue settings)
        if (s.use_templates === true) {
            if (Utils.trim(s.rs_template)) args.push("--rs_template", Utils.q(Utils.trim(s.rs_template)));
            if (Utils.trim(s.om_template)) args.push("--om_template", Utils.q(Utils.trim(s.om_template)));
        } else {
            // Defensive: ignore any stale saved values
            s.rs_template = "";
            s.om_template = "";
        }
        // Range
        if (s.frames_mode === "framespec") {
            args.push("--frames", Utils.q(Utils.trim(s.framespec)));
        } else {
            args.push("--start", Utils.trim(s.start));
            args.push("--end", Utils.trim(s.end));
        }

        if (Utils.trim(s.chunk_size)) args.push("--chunk_size", Utils.trim(s.chunk_size));
        if (Utils.trim(s.chunk_index)) args.push("--index", Utils.trim(s.chunk_index));

        // Concurrency / memory guard
        if (s.concurrency_mode === "fixed") {
            args.push("--concurrency", Utils.trim(s.max_concurrency));
        } else {
            args.push("--concurrency", "0");
            args.push("--max_concurrency", Utils.trim(s.max_concurrency));
            args.push("--ram_per_process_gb", Utils.trim(s.ram_per_process_gb));
        }

        // Flags
        if (s.disable_mfr) args.push("--disable_mfr");
        if (s.no_scratch) args.push("--no_scratch");
        if (!s.stage_project) args.push("--no_stage_project");
        if (s.kill_on_fail) args.push("--kill_on_fail");
// Paths
        if (Utils.trim(s.aerender_path)) args.push("--aerender_path", Utils.q(Utils.trim(s.aerender_path)));
        if (Utils.trim(s.after_effects_dir)) args.push("--after_effects_dir", Utils.q(Utils.trim(s.after_effects_dir)));
        if (Utils.trim(s.scratch_root)) args.push("--scratch_root", Utils.q(Utils.trim(s.scratch_root)));
if (Utils.trim(s.env_file)) args.push("--env_file", Utils.q(Utils.trim(s.env_file)));

        // Behavior
        if (Utils.trim(s.spawn_delay)) args.push("--spawn_delay", Utils.trim(s.spawn_delay));
        if (Utils.trim(s.child_grace_sec)) args.push("--child_grace_sec", Utils.trim(s.child_grace_sec));

        // Dry run
        if (s.mode_dry_run) args.push("--dry_run");

        var baseCmd = py + " " + runner + " " + args.join(" ");

        // OS-specific wrappers
        if (Utils.isWindows()) {
            // Always prefer detached execution to avoid freezing the AE UI thread.
            // Use a wrapper .cmd to avoid cmd quoting brittleness.
            var cmdFile = new File(this.prefsFolder.fsName + "/run_last.cmd");
            var body = "";
            body += "@echo off\r\n";
            body += "setlocal\r\n";
            body += baseCmd + "\r\n";
            body += "endlocal\r\n";
            Utils.writeFile(cmdFile, body);
            return 'cmd.exe /c start "" /b ""' + cmdFile.fsName + '""';
        }

        // macOS: detached execution to keep AE responsive (no stdout capture)
        return '/bin/bash -lc ' + Utils.q("nohup " + baseCmd + " >/dev/null 2>&1 &");
    };

    // =========================================================================
    // View (Simple integrated UI)
    // =========================================================================
    function STMPO_View(model, controller) {
        this.model = model;
        this.controller = controller;
        this.ui = null;
    }

    STMPO_View.prototype.build = function (parentObj) {
        var win = (parentObj instanceof Panel)
            ? parentObj
            : new Window("palette", "STMPO Local Runner", undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 10;
        win.margins = 10;

        // Header
        var header = win.add("group");
        header.orientation = "row";
        header.alignChildren = ["left", "center"];
        header.spacing = 8;

        var title = header.add("statictext", undefined, "STMPO // LOCAL RUNNER");
        try { title.graphics.font = ScriptUI.newFont("Tahoma", "Bold", 16); } catch (e0) {}

        var btnRefresh = header.add("button", undefined, "⚡");
        btnRefresh.helpTip = "Refresh from current project + active comp/work area";
        btnRefresh.preferredSize = [34, 26];

        var btnRQ = header.add("button", undefined, "RQ");
        btnRQ.helpTip = "Open Render Queue panel";
        btnRQ.preferredSize = [34, 26];

        var btnSettings = header.add("button", undefined, "⚙");
        btnSettings.helpTip = "System settings";
        btnSettings.preferredSize = [34, 26];

        // Target panel
        var pTarget = win.add("panel", undefined, "Target Specification");
        pTarget.orientation = "column";
        pTarget.alignChildren = ["fill", "top"];
        pTarget.spacing = 8;
        pTarget.margins = 10;

        // Project row
        var gProj = pTarget.add("group");
        gProj.orientation = "row";
        gProj.alignChildren = ["left", "center"];
        gProj.spacing = 8;

        gProj.add("statictext", undefined, "Project:");
        var etProj = gProj.add("edittext", undefined, "");
        etProj.characters = 38;
        etProj.enabled = false;

        var bProj = gProj.add("button", undefined, "…");
        bProj.preferredSize = [30, 24];

        // Target row
        var gTgt = pTarget.add("group");
        gTgt.orientation = "row";
        gTgt.alignChildren = ["left", "center"];
        gTgt.spacing = 8;

        var ddTgt = gTgt.add("dropdownlist", undefined, ["Comp Name", "RQ Index"]);
        ddTgt.preferredSize = [110, 24];

        var etTgt = gTgt.add("edittext", undefined, "");
        etTgt.characters = 26;

        var bPick = gTgt.add("button", undefined, "Pick Active");
        bPick.preferredSize = [90, 24];

        // Output row
        var gOut = pTarget.add("group");
        gOut.orientation = "row";
        gOut.alignChildren = ["left", "center"];
        gOut.spacing = 8;

        gOut.add("statictext", undefined, "Output:");
        var etOut = gOut.add("edittext", undefined, "");
        etOut.characters = 38;
        etOut.enabled = false;

        var bOut = gOut.add("button", undefined, "…");
        bOut.preferredSize = [30, 24];

        // Templates row (small + optional)
        var gTpl = pTarget.add("group");
        gTpl.orientation = "row";
        gTpl.alignChildren = ["left", "center"];
        gTpl.spacing = 8;
        gTpl.visible = false;
        gTpl.enabled = false;

        gTpl.add("statictext", undefined, "Templates:");
        var etRSTpl = gTpl.add("edittext", undefined, "");
        etRSTpl.characters = 18;
        etRSTpl.helpTip = "Optional Render Settings template name (--rs_template)";

        var etOMTpl = gTpl.add("edittext", undefined, "");
        etOMTpl.characters = 18;
        etOMTpl.helpTip = "Optional Output Module template name (--om_template)";

        // Render Queue panel
        var pRQ = win.add("panel", undefined, "Render Queue (Queued Items)");
        pRQ.orientation = "column";
        pRQ.alignChildren = ["fill", "top"];
        pRQ.spacing = 6;
        pRQ.margins = 10;

        var gRQTop = pRQ.add("group");
        gRQTop.orientation = "row";
        gRQTop.alignChildren = ["left", "center"];
        gRQTop.spacing = 10;

        var cbOnlyQueued = gRQTop.add("checkbox", undefined, "Only QUEUED");
        cbOnlyQueued.value = true;

        var bRQRefresh = gRQTop.add("button", undefined, "Refresh");
        bRQRefresh.preferredSize = [80, 24];

        var bUseSel = gRQTop.add("button", undefined, "Use Selected");
        bUseSel.preferredSize = [100, 24];

        var lbRQ = pRQ.add("listbox", undefined, [], { multiselect: false });
        lbRQ.preferredSize = [0, 120];

        // Scope panel
        var pScope = win.add("panel", undefined, "Execution Scope");
        pScope.orientation = "column";
        pScope.alignChildren = ["fill", "top"];
        pScope.spacing = 8;
        pScope.margins = 10;

        var gFrames = pScope.add("group");
        gFrames.orientation = "row";
        gFrames.alignChildren = ["left", "center"];
        gFrames.spacing = 8;

        var ddFrames = gFrames.add("dropdownlist", undefined, ["Framespec", "Start / End"]);
        ddFrames.preferredSize = [110, 24];

        var etF1 = gFrames.add("edittext", undefined, "");
        etF1.characters = 18;

        var etF2 = gFrames.add("edittext", undefined, "");
        etF2.characters = 10;

        // Chunk row (compact)
        var gChunk = pScope.add("group");
        gChunk.orientation = "row";
        gChunk.alignChildren = ["left", "center"];
        gChunk.spacing = 8;

        gChunk.add("statictext", undefined, "Chunk:");
        var etChunkSize = gChunk.add("edittext", undefined, "");
        etChunkSize.characters = 6;
        etChunkSize.helpTip = "Optional --chunk_size (frames)";

        gChunk.add("statictext", undefined, "Index:");
        var etChunkIndex = gChunk.add("edittext", undefined, "");
        etChunkIndex.characters = 6;
        etChunkIndex.helpTip = "Optional --index (0-based chunk index)";

        var stChunkHint = gChunk.add("statictext", undefined, "blank = off");

        // Performance row
        var gPerf = pScope.add("group");
        gPerf.orientation = "row";
        gPerf.alignChildren = ["left", "center"];
        gPerf.spacing = 8;

        gPerf.add("statictext", undefined, "Procs:");
        var etProcs = gPerf.add("edittext", undefined, "12");
        etProcs.characters = 4;

        gPerf.add("statictext", undefined, "RAM/GB:");
        var etRam = gPerf.add("edittext", undefined, "16");
        etRam.characters = 4;

        var cbAuto = gPerf.add("checkbox", undefined, "Auto");
        cbAuto.value = true;

        // Action row
        var gAct = win.add("group");
        gAct.orientation = "row";
        gAct.alignChildren = ["left", "center"];
        gAct.spacing = 12;

        var cbDry = gAct.add("checkbox", undefined, "Dry Run");
        var cbBg = gAct.add("checkbox", undefined, "Background");
        cbBg.value = true;
        cbBg.enabled = false;
        cbBg.helpTip = "Always runs detached to keep After Effects responsive. Use the Runner Console for pause/stop.";

        var cbAudio = gAct.add("checkbox", undefined, "Audio");
        cbAudio.value = true;
        cbAudio.helpTip = "Controls aerender -sound. On = include audio (if your Output Module supports it).";

        // This panel always launches the runner detached to keep After Effects responsive.
        // Keep the control visible for clarity, but disable toggling.
        cbBg.enabled = false;
        cbBg.helpTip = "Always runs detached (background) so AE doesn't freeze.";

        var bLog = gAct.add("button", undefined, "Open Log");
        bLog.preferredSize = [90, 28];

        var bRun = gAct.add("button", undefined, "INITIALIZE RUNNER");
        bRun.preferredSize = [220, 40];

        // Console panel
        var pConsole = win.add("panel", undefined, "Runner Console");
        pConsole.orientation = "column";
        pConsole.alignChildren = ["fill", "top"];
        pConsole.spacing = 6;
        pConsole.margins = 10;

        var gCStatus = pConsole.add("group");
        gCStatus.orientation = "row";
        gCStatus.alignChildren = ["left", "center"];
        gCStatus.spacing = 8;

        gCStatus.add("statictext", undefined, "Status:");
        var stStatus = gCStatus.add("statictext", undefined, "Idle");
        stStatus.characters = 28;

        gCStatus.add("statictext", undefined, "Progress:");
        var stPct = gCStatus.add("statictext", undefined, "0%");
        stPct.characters = 6;

        var pb = pConsole.add("progressbar", undefined, 0, 100);
        pb.preferredSize = [0, 14];

        var gCBtns = pConsole.add("group");
        gCBtns.orientation = "row";
        gCBtns.alignChildren = ["left", "center"];
        gCBtns.spacing = 8;

        var bPause = gCBtns.add("button", undefined, "Pause");
        var bResume = gCBtns.add("button", undefined, "Resume");
        var bStop = gCBtns.add("button", undefined, "Stop");
        var bRevealLog = gCBtns.add("button", undefined, "Reveal Log");
        var bClearView = gCBtns.add("button", undefined, "Clear View");

        bPause.preferredSize = [80, 24];
        bResume.preferredSize = [80, 24];
        bStop.preferredSize = [80, 24];
        bRevealLog.preferredSize = [90, 24];
        bClearView.preferredSize = [90, 24];

        var etConsole = pConsole.add("edittext", undefined, "", { multiline: true, scrolling: true, readonly: true });
        etConsole.preferredSize = [0, 220];
        etConsole.helpTip = "Live tail of last_run.log";

        // Stash refs
        this.ui = {
            win: win,
            header: { btnRefresh: btnRefresh, btnRQ: btnRQ, btnSettings: btnSettings },
            target: {
                etProj: etProj, bProj: bProj,
                ddTgt: ddTgt, etTgt: etTgt, bPick: bPick,
                etOut: etOut, bOut: bOut,
                etRSTpl: etRSTpl, etOMTpl: etOMTpl
            },
            rq: { cbOnlyQueued: cbOnlyQueued, bRQRefresh: bRQRefresh, bUseSel: bUseSel, lbRQ: lbRQ },
            scope: {
                ddFrames: ddFrames, etF1: etF1, etF2: etF2,
                etChunkSize: etChunkSize, etChunkIndex: etChunkIndex,
                etProcs: etProcs, etRam: etRam, cbAuto: cbAuto
            },
            act: { cbDry: cbDry, cbBg: cbBg, cbAudio: cbAudio, bLog: bLog, bRun: bRun },
            console: {
                panel: pConsole,
                stStatus: stStatus,
                stPct: stPct,
                pb: pb,
                et: etConsole,
                bPause: bPause,
                bResume: bResume,
                bStop: bStop,
                bRevealLog: bRevealLog,
                bClearView: bClearView
            }
        };

        this.bindEvents();

        if (win instanceof Window) {
            win.preferredSize = [520, 900];
        }

        win.layout.layout(true);
        win.layout.resize();

        return win;
    };

    STMPO_View.prototype._setDropdownIndex = function (dd, idx) {
        try {
            if (!dd || !dd.items || dd.items.length === 0) return;
            idx = Math.max(0, Math.min(dd.items.length - 1, idx));
            dd.selection = dd.items[idx];
        } catch (e) {}
    };

    STMPO_View.prototype.syncFromModel = function () {
        var s = this.model.state;
        var u = this.ui;
        if (!u) return;

        // Project / output
        u.target.etProj.text = Utils.truncateMiddle(s.project_path || "", 60);
        u.target.etProj.helpTip = s.project_path || "";
        u.target.etOut.text = Utils.truncateMiddle(s.output_path || "", 60);
        u.target.etOut.helpTip = s.output_path || "";

        // Target mode
        this._setDropdownIndex(u.target.ddTgt, (s.target_mode === "comp") ? 0 : 1);
        u.target.etTgt.text = (s.target_mode === "comp") ? (s.comp_name || "") : (s.rq_index || "1");
        u.target.bPick.enabled = (s.target_mode === "comp");

        // Templates
        u.target.etRSTpl.text = s.rs_template || "";
        u.target.etOMTpl.text = s.om_template || "";

        // Frames mode
        this._setDropdownIndex(u.scope.ddFrames, (s.frames_mode === "framespec") ? 0 : 1);
        if (s.frames_mode === "framespec") {
            u.scope.etF1.text = s.framespec || "";
            u.scope.etF2.visible = false;
        } else {
            u.scope.etF1.text = s.start || "";
            u.scope.etF2.text = s.end || "";
            u.scope.etF2.visible = true;
        }

        // Chunk
        u.scope.etChunkSize.text = s.chunk_size || "";
        u.scope.etChunkIndex.text = s.chunk_index || "";

        // Perf
        u.scope.etProcs.text = s.max_concurrency || "12";
        u.scope.etRam.text = s.ram_per_process_gb || "16";
        u.scope.cbAuto.value = (s.concurrency_mode === "auto");
        u.scope.etProcs.enabled = !u.scope.cbAuto.value;
        u.scope.etRam.enabled = !u.scope.cbAuto.value;

        // Flags
        u.act.cbDry.value = !!s.mode_dry_run;
        // Always detached to keep AE responsive.
        u.act.cbBg.value = true;
        s.mode_background = true;
        u.act.cbAudio.value = (String(s.sound || "ON").toUpperCase() !== "OFF");

        // RQ
        u.rq.cbOnlyQueued.value = !!s.rq_only_queued;

        try { u.win.layout.layout(true); } catch (e) {}
    };

    STMPO_View.prototype.populateRQList = function (rows) {
        var u = this.ui;
        if (!u) return;

        var lb = u.rq.lbRQ;
        if (!lb) return;

        // Clear
        try {
            if (lb.removeAll) {
                lb.removeAll();
            } else {
                while (lb.items.length) lb.remove(lb.items[0]);
            }
        } catch (e0) {}

        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var label = "#" + r.rqIndex + "  [" + r.statusName + "]  " + (r.compName || "<comp>") + "  →  " + Utils.truncateMiddle(r.outPath || "", 48);
            var it = lb.add("item", label);
            it._rqIndex = r.rqIndex;
            it._row = r;
        }

        try { if (lb.items.length > 0) lb.selection = lb.items[0]; } catch (e1) {}
    };

    STMPO_View.prototype.bindEvents = function () {
        var self = this;
        var s = this.model.state;
        var u = this.ui;

        function pickOpenProject() {
            var f = File.openDialog("Select After Effects Project (*.aep)", "*.aep", false);
            return f ? f.fsName : null;
        }

        function pickSaveOutput() {
            var f = File.saveDialog("Select output file path (movie or image sequence pattern)", "*.*");
            return f ? f.fsName : null;
        }

        // Header
        u.header.btnRefresh.onClick = function () { self.controller.refreshFromAE(); };
        u.header.btnRQ.onClick = function () { self.controller.openRenderQueuePanel(); };
        u.header.btnSettings.onClick = function () { self.controller.showSettingsDialog(); };

        // Project browse
        u.target.bProj.onClick = function () {
            var p = pickOpenProject();
            if (p) { s.project_path = p; self.syncFromModel(); }
        };

        // Output browse
        u.target.bOut.onClick = function () {
            var p = pickSaveOutput();
            if (p) { s.output_path = p; self.syncFromModel(); }
        };

        // Target mode
        u.target.ddTgt.onChange = function () {
            try {
                if (!this.selection) return;
                s.target_mode = (this.selection.index === 0) ? "comp" : "rqindex";
                self.syncFromModel();
            } catch (e) {}
        };

        u.target.bPick.onClick = function () { self.controller.pickActiveComp(); };

        u.target.etTgt.onChanging = function () {
            if (s.target_mode === "comp") s.comp_name = this.text;
            else s.rq_index = this.text;
        };

        // Templates
        u.target.etRSTpl.onChanging = function () { s.rs_template = this.text; };
        u.target.etOMTpl.onChanging = function () { s.om_template = this.text; };

        // RQ controls
        u.rq.cbOnlyQueued.onClick = function () {
            s.rq_only_queued = !!this.value;
            self.controller.refreshRQ();
        };

        u.rq.bRQRefresh.onClick = function () { self.controller.refreshRQ(); };

        u.rq.bUseSel.onClick = function () {
            var lb = u.rq.lbRQ;
            if (!lb || !lb.selection) {
                alert("Select a Render Queue item first.");
                return;
            }
            var rqIndex = lb.selection._rqIndex;
            if (!rqIndex) {
                alert("Selection did not contain a valid RQ index.");
                return;
            }
            self.controller.applyRQIndex(rqIndex);
        };

        // Frames mode
        u.scope.ddFrames.onChange = function () {
            try {
                if (!this.selection) return;
                s.frames_mode = (this.selection.index === 0) ? "framespec" : "startend";
                self.syncFromModel();
            } catch (e) {}
        };

        u.scope.etF1.onChanging = function () {
            if (s.frames_mode === "framespec") s.framespec = this.text;
            else s.start = this.text;
        };

        u.scope.etF2.onChanging = function () { s.end = this.text; };

        // Chunk
        u.scope.etChunkSize.onChanging = function () { s.chunk_size = this.text; };
        u.scope.etChunkIndex.onChanging = function () { s.chunk_index = this.text; };

        // Perf
        u.scope.cbAuto.onClick = function () {
            s.concurrency_mode = this.value ? "auto" : "fixed";
            self.syncFromModel();
        };

        u.scope.etProcs.onChanging = function () { s.max_concurrency = this.text; };
        u.scope.etRam.onChanging = function () { s.ram_per_process_gb = this.text; };

        // Flags
        u.act.cbDry.onClick = function () { s.mode_dry_run = !!this.value; };
        u.act.cbAudio.onClick = function () { s.sound = this.value ? "ON" : "OFF"; };

        // Log
        u.act.bLog.onClick = function () {
            self.model.save();
            Utils.ensureFolder(self.model.prefsFolder);
            if (!self.model.logFile.exists) Utils.writeFile(self.model.logFile, "");
            Utils.openInOS(self.model.logFile.fsName);
        };

        // Console controls
        u.console.bPause.onClick = function () { self.controller.pause(); };
        u.console.bResume.onClick = function () { self.controller.resume(); };
        u.console.bStop.onClick = function () { self.controller.stop(); };
        u.console.bRevealLog.onClick = function () { Utils.revealInOS(self.model.logFile.fsName); };
        u.console.bClearView.onClick = function () { try { u.console.et.text = ""; } catch (e) {} };

        // Run
        u.act.bRun.onClick = function () { self.controller.run(); };
    };

    // =========================================================================
    // Controller
    // =========================================================================
    function STMPO_Controller(model) {
        this.model = model;
        this.view = null;

        // Console monitor state
        this._monitorEnabled = false;
        this._pollMs = 500;
        this._maxTailBytes = 96 * 1024;
        this._lastTail = null;
        this._childRanges = {}; // pid -> {s,e,total}
        this._childProgress = {}; // pid -> framesRenderedWithinRange
        this._runnerPid = null;
        this._status = "Idle";
        this._paused = false;
    }

    // ---- Console monitoring (uses app.scheduleTask, which evals strings)
    STMPO_Controller.prototype._ensureGlobalPoll = function () {
        if ($.global.__STMPO_LR_POLL_INSTALLED) return;
        $.global.__STMPO_LR_POLL_INSTALLED = true;
        $.global.__STMPO_LR_POLL = function () {
            try {
                var c = $.global.__STMPO_LR_CONTROLLER;
                if (!c || !c._monitorEnabled) return;
                c._pollConsoleOnce();
                app.scheduleTask("$.global.__STMPO_LR_POLL()", c._pollMs, false);
            } catch (e) {}
        };
    };

    STMPO_Controller.prototype._setConsole = function (status, pct, tail) {
        try {
            var u = this.view && this.view.ui ? this.view.ui.console : null;
            if (!u) return;
            if (status !== undefined && status !== null) u.stStatus.text = String(status);
            if (pct !== undefined && pct !== null) {
                var p = Math.max(0, Math.min(100, Math.round(pct)));
                u.pb.value = p;
                u.stPct.text = p + "%";
            }
            if (tail !== undefined && tail !== null) u.et.text = String(tail);
            if (u.panel && u.panel.layout) {
                u.panel.layout.layout(true);
                if (this.view.win && this.view.win.layout) this.view.win.layout.layout(true);
            }
        } catch (e) {}
    };

    STMPO_Controller.prototype.startMonitor = function () {
        this._ensureGlobalPoll();
        $.global.__STMPO_LR_CONTROLLER = this;
        this._monitorEnabled = true;
        app.scheduleTask("$.global.__STMPO_LR_POLL()", this._pollMs, false);
    };

    STMPO_Controller.prototype.stopMonitor = function () {
        this._monitorEnabled = false;
    };

    STMPO_Controller.prototype._pollConsoleOnce = function () {
        var tail = Utils.readFileTail(this.model.logFile, this._maxTailBytes) || "";
        if (tail === this._lastTail) {
            // Still update status/progress if we can, but avoid re-writing huge text each tick.
        }

        // Parse runner PID
        var m = tail.match(/Runner PID:\s*(\d+)/);
        if (m && m[1]) this._runnerPid = parseInt(m[1], 10);
        // Prefer explicit pid file (written at runner start)
        try {
            if (this.model.pidFile && this.model.pidFile.exists) {
                var pidTxt = Utils.readFile(this.model.pidFile) || "";
                var pidN = parseInt(pidTxt, 10);
                if (!isNaN(pidN) && pidN > 0) this._runnerPid = pidN;
            }
        } catch (ePid) {}

        // Parse child ranges (pid mapping)
        var reLaunch = /Launched child\[\d+\]\s+pid=(\d+)\s+frames=(\d+)-(\d+)/g;
        var mm;
        while ((mm = reLaunch.exec(tail)) !== null) {
            var pid = parseInt(mm[1], 10);
            var s = parseInt(mm[2], 10);
            var e = parseInt(mm[3], 10);
            if (!isNaN(pid) && !isNaN(s) && !isNaN(e)) {
                this._childRanges[pid] = { s: s, e: e, total: Math.max(1, (e - s + 1)) };
            }
        }

        // Parse per-child progress
        var reProg = /\[(\d+)\s+STDOUT\]\s+PROGRESS:.*\((\d+)\):/g;
        while ((mm = reProg.exec(tail)) !== null) {
            var ppid = parseInt(mm[1], 10);
            var f = parseInt(mm[2], 10);
            if (!isNaN(ppid) && !isNaN(f)) {
                this._childProgress[ppid] = f;
            }
        }

        // Completion status
        var status = "Running";
        var rcMatch = tail.match(/Run complete rc=(\d+)/);
        if (rcMatch && rcMatch[1] !== undefined) {
            var rc = parseInt(rcMatch[1], 10);
            if (rc === 0) {
                status = "Completed";
            } else if (rc === 130 || rc === 143) {
                status = "Stopped";
            } else {
                status = "Failed";
            }
            this._monitorEnabled = false;
        }
        if (this._paused) status = "Paused";

        // Compute overall percent (weighted by frame ranges when available)
        var sumTotal = 0;
        var sumDone = 0;
        for (var k in this._childRanges) {
            if (!this._childRanges.hasOwnProperty(k)) continue;
            var info = this._childRanges[k];
            var pidKey = parseInt(k, 10);
            var done = this._childProgress[pidKey] || 0;
            var capped = Math.max(0, Math.min(info.total, done));
            sumTotal += info.total;
            sumDone += capped;
        }

        // Fallback for older logs that don't include pid<->range mapping:
        // use the UI-selected frame range and the max progress observed from any child.
        if (sumTotal <= 0) {
            var fs = parseInt(this.model.state.frame_start, 10);
            var fe = parseInt(this.model.state.frame_end, 10);
            if (!isNaN(fs) && !isNaN(fe) && fe >= fs) {
                sumTotal = (fe - fs + 1);
                var maxDone = 0;
                for (var p in this._childProgress) {
                    if (!this._childProgress.hasOwnProperty(p)) continue;
                    var v = parseInt(this._childProgress[p], 10);
                    if (!isNaN(v)) maxDone = Math.max(maxDone, v);
                }
                sumDone = Math.max(0, Math.min(sumTotal, maxDone));
            }
        }
        var pct = (sumTotal > 0) ? (100 * (sumDone / sumTotal)) : 0;

        this._status = status;
        if (tail !== this._lastTail) {
            this._setConsole(status, pct, tail);
            this._lastTail = tail;
        } else {
            this._setConsole(status, pct, null);
        }
    };

    STMPO_Controller.prototype._activeChildPids = function () {
        var pids = [];
        for (var k in this._childRanges) {
            if (this._childRanges.hasOwnProperty(k)) pids.push(parseInt(k, 10));
        }
        // If we don't have child ranges yet, fall back to any pids seen in progress lines
        if (pids.length === 0) {
            for (var kk in this._childProgress) {
                if (this._childProgress.hasOwnProperty(kk)) pids.push(parseInt(kk, 10));
            }
        }
        return pids;
    };

    STMPO_Controller.prototype.pause = function () {
        var pids = this._activeChildPids();
        if (pids.length === 0 && this._runnerPid) pids = [this._runnerPid];
        if (pids.length === 0) {
            alert("No running PID found yet. Start a run, then wait for the runner to log its PID.");
            return;
        }
        try {
            if (Utils.isWindows()) {
                for (var i = 0; i < pids.length; i++) {
                    system.callSystem('powershell -NoProfile -Command "Suspend-Process -Id ' + pids[i] + '"');
                }
            } else {
                system.callSystem("/bin/kill -STOP " + pids.join(" "));
            }
            this._paused = true;
            this._setConsole("Paused", null, null);
        } catch (e) {
            alert("Pause failed: " + e.toString());
        }
    };

    STMPO_Controller.prototype.resume = function () {
        var pids = this._activeChildPids();
        if (pids.length === 0 && this._runnerPid) pids = [this._runnerPid];
        if (pids.length === 0) {
            alert("No PID found to resume.");
            return;
        }
        try {
            if (Utils.isWindows()) {
                for (var i = 0; i < pids.length; i++) {
                    system.callSystem('powershell -NoProfile -Command "Resume-Process -Id ' + pids[i] + '"');
                }
            } else {
                system.callSystem("/bin/kill -CONT " + pids.join(" "));
            }
            this._paused = false;
            this._setConsole("Running", null, null);
        } catch (e) {
            alert("Resume failed: " + e.toString());
        }
    };

    STMPO_Controller.prototype.stop = function () {
        // Stop should not block the AE UI. We launch a detached stopper script that:
        // 1) sends SIGTERM to the runner (graceful: lets Python kill its aerender children),
        // 2) escalates to SIGKILL if needed,
        // 3) as a final safety net, kills any child PIDs parsed from last_run.log.
        try {
            var prefs = this.model.prefsFolder;
            Utils.ensureFolder(prefs);

            var pidFile = this.model.pidFile;
            var logFile = this.model.logFile;

            this._setConsole("Stopping…", null, "(sent stop request)\nLog: " + logFile.fsName);

            if (Utils.isWindows()) {
                var stopCmd = new File(prefs.fsName + "/stop_last.cmd");

                // Use PowerShell for robust PID extraction from log.
                var ps = '';
                ps += '$log=' + "'" + logFile.fsName.replace(/'/g, "''") + "'" + ';';
                ps += 'if (Test-Path $log) {';
                ps += "  $pids = (Select-String -Path $log -Pattern 'Launched child\[\d+\]\s+pid=(\d+)' -AllMatches | ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique);";
                ps += '  foreach($p in $pids){ try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {} }';
                ps += '}';

                var body = '';
                body += '@echo off\r\n';
                body += 'setlocal EnableExtensions EnableDelayedExpansion\r\n';
                body += 'set "PIDFILE=' + pidFile.fsName + '"\r\n';
                body += 'set "LOGFILE=' + logFile.fsName + '"\r\n';
                body += 'set "PID="\r\n';
                body += 'if exist "%PIDFILE%" (\r\n';
                body += '  for /f "usebackq delims=" %%A in ("%PIDFILE%") do set "PID=%%A"\r\n';
                body += ')\r\n';
                body += 'if not "%PID%"=="" (\r\n';
                body += '  taskkill /PID %PID% /T >nul 2>&1\r\n';
                body += '  ping 127.0.0.1 -n 3 >nul\r\n';
                body += '  taskkill /PID %PID% /T /F >nul 2>&1\r\n';
                body += ')\r\n';
                body += 'powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps.replace(/"/g, '\\"') + '" >nul 2>&1\r\n';
                body += 'del "%PIDFILE%" >nul 2>&1\r\n';
                body += 'endlocal\r\n';

                Utils.writeFile(stopCmd, body);

                // Detached
                system.callSystem('cmd.exe /c start "" /b "' + stopCmd.fsName + '"');
            } else {
                var stopSh = new File(prefs.fsName + "/stop_last.sh");

                var sh = '';
                sh += '#!/bin/bash\n';
                sh += 'PIDFILE=' + Utils.q(pidFile.fsName) + '\n';
                sh += 'LOGFILE=' + Utils.q(logFile.fsName) + '\n';
                sh += 'PID=""\n';
                sh += 'if [ -f "$PIDFILE" ]; then PID=$(cat "$PIDFILE" 2>/dev/null | tr -d "\\r\\n"); fi\n';
                sh += 'if [ -n "$PID" ]; then\n';
                sh += '  /bin/kill -TERM "$PID" 2>/dev/null || true\n';
                sh += '  for i in $(seq 1 40); do\n';
                sh += '    /bin/kill -0 "$PID" 2>/dev/null || break\n';
                sh += '    sleep 0.2\n';
                sh += '  done\n';
                sh += '  /bin/kill -KILL "$PID" 2>/dev/null || true\n';
                sh += 'fi\n';
                sh += 'if [ -f "$LOGFILE" ]; then\n';
                sh += '  PIDS=$(grep -Eo "Launched child\\[[0-9]+\\]\\s+pid=[0-9]+" "$LOGFILE" 2>/dev/null | sed -E "s/.*pid=([0-9]+)/\\1/g" | sort -u)\n';
                sh += '  for p in $PIDS; do /bin/kill -TERM "$p" 2>/dev/null || true; done\n';
                sh += '  sleep 0.3\n';
                sh += '  for p in $PIDS; do /bin/kill -KILL "$p" 2>/dev/null || true; done\n';
                sh += 'fi\n';
                sh += 'rm -f "$PIDFILE" 2>/dev/null || true\n';

                Utils.writeFile(stopSh, sh);

                // Detached
                var cmd = '/bin/bash -lc ' + Utils.q('nohup /bin/bash ' + Utils.q(stopSh.fsName) + ' >/dev/null 2>&1 &');
                system.callSystem(cmd);
            }

            // Keep monitoring briefly so the console reflects the shutdown.
            this.startMonitor();
        } catch (e) {
            alert("Stop failed:\n" + e.toString());
        }
    };

    STMPO_Controller.prototype.refreshFromAE = function () {
        var s = this.model.state;

        // Update project path if project is saved
        try {
            if (app.project && app.project.file) {
                s.project_path = app.project.file.fsName;
            }
        } catch (e0) {}

        // Active comp -> comp name + work area framespec guess
        try {
            if (app.project && app.project.activeItem && (app.project.activeItem instanceof CompItem)) {
                var comp = app.project.activeItem;
                s.comp_name = comp.name;
                s.target_mode = "comp";

                // Derive framespec from work area (display frame numbers if possible)
                var fd = comp.frameDuration;
                var waStart = comp.workAreaStart;
                var waDur = comp.workAreaDuration;

                var baseFrame = null;
                try {
                    if (comp.displayStartFrame !== undefined && comp.displayStartFrame !== null) baseFrame = comp.displayStartFrame;
                } catch (e1) { baseFrame = null; }

                if (baseFrame === null) {
                    try { baseFrame = Math.round((comp.displayStartTime || 0) / fd); } catch (e2) { baseFrame = 0; }
                }

                var startOff = Math.floor((waStart / fd) + 1e-9);
                var endOffEx = Math.floor(((waStart + waDur) / fd) + 1e-9);
                var endOff = Math.max(startOff, endOffEx - 1);

                s.frames_mode = "framespec";
                s.framespec = (baseFrame + startOff) + "-" + (baseFrame + endOff);
            }
        } catch (e3) {}

        // Ensure aerender/AE-dir are coherent with the currently running AE
        try { Utils.autofillAEPathsIfMissing(s); } catch (eAuto1) {}

        this.model.save();
        this.view.syncFromModel();
    };

    STMPO_Controller.prototype.openRenderQueuePanel = function () {
        try {
            if (app.project && app.project.renderQueue && app.project.renderQueue.showWindow) {
                app.project.renderQueue.showWindow(true);
                return;
            }
        } catch (e0) {}

        // Fallback: menu command
        try {
            var id = app.findMenuCommandId("Render Queue");
            if (id) app.executeCommand(id);
        } catch (e1) {}
    };

    STMPO_Controller.prototype.refreshRQ = function () {
        var s = this.model.state;
        var rows = this.model.getRenderQueueRows(!!s.rq_only_queued);
        this.view.populateRQList(rows);
        this.model.save();
        this.view.syncFromModel();
    };

    STMPO_Controller.prototype.applyRQIndex = function (rqIndex) {
        this.model.applyRenderQueueSelection(rqIndex);
        this.model.save();
        this.view.syncFromModel();
    };

    STMPO_Controller.prototype.pickActiveComp = function () {
        var s = this.model.state;
        try {
            if (app.project && app.project.activeItem && (app.project.activeItem instanceof CompItem)) {
                s.comp_name = app.project.activeItem.name;
                s.target_mode = "comp";
                this.model.save();
                this.view.syncFromModel();
            } else {
                alert("Please select a composition in the Project panel or open one in the viewer.");
            }
        } catch (e) {
            alert("Unable to read active comp: " + e.toString());
        }
    };

    STMPO_Controller.prototype.showSettingsDialog = function () {
        var s = this.model.state;

        var d = new Window("dialog", "STMPO System Settings");
        d.alignChildren = ["fill", "top"];
        d.spacing = 10;
        d.margins = 12;

        // ---- Paths
        var pPaths = d.add("panel", undefined, "Paths");
        pPaths.alignChildren = ["fill", "top"];
        pPaths.spacing = 6;
        pPaths.margins = 10;

        function row(parent, label) {
            var g = parent.add("group");
            g.orientation = "row";
            g.alignChildren = ["fill", "center"];
            g.spacing = 8;
            if (label) {
                var st = g.add("statictext", undefined, label);
                st.preferredSize = [120, -1];
            }
            return g;
        }

        var rRunner = row(pPaths, "Runner Script:");
        var eRunner = rRunner.add("edittext", undefined, s.runner_path || "");
        eRunner.characters = 52;
        var bRunner = rRunner.add("button", undefined, "…");
        bRunner.preferredSize = [30, 24];
        bRunner.onClick = function () {
            var p = File.openDialog("Locate stmpo_local_render.py", "*.py", false);
            if (p) eRunner.text = p.fsName;
        };


var rInstall = pPaths.add("group");
rInstall.orientation = "row";
rInstall.alignChildren = ["left", "center"];
var bInstall = rInstall.add("button", undefined, "Install/Update Runner");
bInstall.helpTip = "Copies the bundled Python runner (stmpo_local_render.py + stmpo/) next to this .jsx into your STMPO_LocalRunner preferences folder.";
bInstall.onClick = function () {
    var ok = model.installOrUpdateRunnerFromBundle();
    if (ok) {
        eRunner.text = model.state.runner_path;
        alert("STMPO runner installed/updated in preferences.");
    } else {
        alert("Runner install failed. Ensure stmpo_local_render.py and the stmpo/ folder sit next to this .jsx file.");
    }
};

        var rPy = row(pPaths, "Python 3:");
        var ePy = rPy.add("edittext", undefined, s.python_path || "");
        ePy.characters = 52;
        ePy.helpTip = "Optional. Can be a path to python.exe/python3, or a command like: py -3";

        var rAer = row(pPaths, "aerender:");
        var eAer = rAer.add("edittext", undefined, s.aerender_path || "");
        eAer.characters = 52;
        eAer.helpTip = "Optional override for aerender path";

        var rAEDir = row(pPaths, "AE Dir:");
        var eAEDir = rAEDir.add("edittext", undefined, s.after_effects_dir || "");
        eAEDir.characters = 52;
        eAEDir.helpTip = "Optional After Effects install dir (if runner needs it)";

        // ---- Env / scratch
        var pScratch = d.add("panel", undefined, "Scratch / Environment");
        pScratch.alignChildren = ["fill", "top"];
        pScratch.spacing = 6;
        pScratch.margins = 10;

        var rScratch = row(pScratch, "Scratch Root:");
        var eScratch = rScratch.add("edittext", undefined, s.scratch_root || "");
        eScratch.characters = 52;
        var bScratch = rScratch.add("button", undefined, "…");
        bScratch.preferredSize = [30, 24];
        bScratch.onClick = function () {
            var f = Folder.selectDialog("Select Scratch Root Folder");
            if (f) eScratch.text = f.fsName;
        };

        var rEnv = row(pScratch, "Env File:");
        var eEnv = rEnv.add("edittext", undefined, s.env_file || "");
        eEnv.characters = 52;
        var bEnv = rEnv.add("button", undefined, "…");
        bEnv.preferredSize = [30, 24];
        bEnv.onClick = function () {
            var p = File.openDialog("Select env file", "*.*", false);
            if (p) eEnv.text = p.fsName;
        };

        var gScratchFlags = pScratch.add("group");
        gScratchFlags.orientation = "row";
        gScratchFlags.alignChildren = ["left", "center"];
        gScratchFlags.spacing = 12;

        var cbNoScratch = gScratchFlags.add("checkbox", undefined, "No Scratch (--no_scratch)");
        cbNoScratch.value = !!s.no_scratch;

        var cbStage = gScratchFlags.add("checkbox", undefined, "Stage Project (recommended)");
        cbStage.value = !!s.stage_project;

        // ---- Orchestrator
        var pOrch = d.add("panel", undefined, "Orchestrator");
        pOrch.alignChildren = ["fill", "top"];
        pOrch.spacing = 6;
        pOrch.margins = 10;

        var rDelay = row(pOrch, "Spawn Delay:");
        var eSpawn = rDelay.add("edittext", undefined, s.spawn_delay || "");
        eSpawn.characters = 10;
        rDelay.add("statictext", undefined, "sec");

        var rGrace = row(pOrch, "Child Grace:");
        var eGrace = rGrace.add("edittext", undefined, s.child_grace_sec || "");
        eGrace.characters = 10;
        rGrace.add("statictext", undefined, "sec");

        var gOrchFlags = pOrch.add("group");
        gOrchFlags.orientation = "row";
        gOrchFlags.alignChildren = ["left", "center"];
        gOrchFlags.spacing = 12;

        var cbKill = gOrchFlags.add("checkbox", undefined, "Kill on Fail");
        cbKill.value = !!s.kill_on_fail;

        var cbDisableMFR = gOrchFlags.add("checkbox", undefined, "Disable MFR");
        cbDisableMFR.value = !!s.disable_mfr;

        // Buttons
        var gBtns = d.add("group");
        gBtns.orientation = "row";
        gBtns.alignment = "right";
        gBtns.spacing = 10;

        var bCancel = gBtns.add("button", undefined, "Cancel");
        var bSave = gBtns.add("button", undefined, "Save", { name: "ok" });

        bCancel.onClick = function () { d.close(); };

        bSave.onClick = function () {
            s.runner_path = Utils.trim(eRunner.text);
            s.python_path = Utils.trim(ePy.text);
            s.aerender_path = Utils.trim(eAer.text);
            s.after_effects_dir = Utils.trim(eAEDir.text);

            s.scratch_root = Utils.trim(eScratch.text);
            s.env_file = Utils.trim(eEnv.text);

            s.no_scratch = !!cbNoScratch.value;
            s.stage_project = !!cbStage.value;

            s.spawn_delay = Utils.trim(eSpawn.text);
            s.child_grace_sec = Utils.trim(eGrace.text);

            s.kill_on_fail = !!cbKill.value;
            s.disable_mfr = !!cbDisableMFR.value;

            d.close();
        };

        d.show();

        this.model.save();
        this.view.syncFromModel();
    };

    STMPO_Controller.prototype._isFiniteNumber = function (x) {
        var n = parseFloat(x);
        return !(isNaN(n) || !isFinite(n));
    };

    STMPO_Controller.prototype.run = function () {
        var s = this.model.state;

        // Auto-fill aerender / AE install dir (prevents python discovery from picking an older AE).
        try { Utils.autofillAEPathsIfMissing(s); } catch (eAuto2) {}


        // Validate
        if (!Utils.trim(s.runner_path)) {
            alert("Missing runner script path (stmpo_local_render.py). Click ⚙ to set it.");
            return;
        }
        if (!Utils.fileExists(s.runner_path)) {
            alert("Runner script not found on disk:\n\n" + s.runner_path);
            return;
        }
        if (!Utils.trim(s.project_path)) {
            alert("Missing project path.");
            return;
        }
        if (!Utils.fileExists(s.project_path)) {
            alert("Project file not found on disk:\n\n" + s.project_path);
            return;
        }
        if (!Utils.trim(s.output_path)) {
            alert("Missing output path.");
            return;
        }
        if (s.target_mode === "comp" && !Utils.trim(s.comp_name)) {
            alert("Target mode is Comp Name, but comp name is empty.");
            return;
        }
        if (s.target_mode === "rqindex" && !Utils.trim(s.rq_index)) {
            alert("Target mode is RQ Index, but rq index is empty.");
            return;
        }
        if (s.frames_mode === "framespec" && !Utils.trim(s.framespec)) {
            alert("Frames mode is Framespec, but framespec is empty.");
            return;
        }
        if (s.frames_mode === "startend") {
            if (!Utils.trim(s.start) || !Utils.trim(s.end)) {
                alert("Frames mode is Start/End, but start or end is empty.");
                return;
            }
            if (!this._isFiniteNumber(s.start) || !this._isFiniteNumber(s.end)) {
                alert("Start/End must be numeric.");
                return;
            }
        }

        // Python 3 detection check (gives a better error than a null command later)
        var py = Utils.detectPython3Command(s.python_path);
        if (!py) {
            alert("Python 3 was not found or could not be validated.\n\nFix:\n- Install Python 3 OR\n- Set an explicit Python 3 path/command in ⚙ (e.g. 'py -3' on Windows, or 'python3' on macOS).\n");
            return;
        }

        this.model.save();

        var cmd = this.model.buildCommand();
        if (!cmd) {
            alert("Failed to build command (Python 3 detection or runner config issue).\nClick ⚙ to review settings.");
            return;
        }

        // Dry run -> show command
        if (s.mode_dry_run) {
            Utils.alertLong("Dry Run Command", cmd);
            return;
        }

        // Always detached to keep AE responsive; console UI provides progress + controls.
        s.mode_background = true;
        try { this.model.pidFile.remove(); } catch (ePid) {}

        // Execute
        try {
            system.callSystem(cmd);
            this._setConsole("Starting…", 0, "(launched detached)\nLog: " + this.model.logFile.fsName);
            this.startMonitor();
        } catch (e) {
            alert("System Call Failed:\n" + e.toString() + "\n\nCommand:\n" + cmd);
        }
    };

    // =========================================================================
    // Main
    // =========================================================================
    function main() {
        var model = new STMPO_Model();
        model.load();

        // Auto-fill aerender / AE install dir from the currently running After Effects (prevents mismatched aerender).
        try { Utils.autofillAEPathsIfMissing(model.state); } catch (eAuto0) {}

        var controller = new STMPO_Controller(model);
        var view = new STMPO_View(model, controller);
        controller.view = view;

        var win = view.build(thisObj);
        view.syncFromModel();

        // Populate RQ list on launch
        try { controller.refreshRQ(); } catch (e0) {}

        if (win instanceof Window) {
            win.center();
            win.show();
        }
    }

    try {
        main();
    } catch (e) {
        alert("STMPO Local Runner failed to initialize:\n\n" + e.toString());
    }

})(this);
