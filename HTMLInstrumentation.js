/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */


/*unittests: HTML Instrumentation*/

/**
 * HTMLInstrumentation
 *
 * This module contains functions for "instrumenting" html code so that we can track
 * the relationship of source code to DOM nodes in the browser. This functionality is
 * used by both live highlighting and live HTML editing.
 *
 * During live HTML development, the HTML source code is parsed to identify tag boundaries.
 * Each tag is assigned an ID which is stored in markers that are inserted into the session.
 * These IDs are also included in "data-cloud9-id" attributes that are inserted in the
 * HTML code that's served to the browser via the Live Development server.
 *
 * The primary function for that functionality is generateInstrumentedHTML(). This does just 
 * what it says - it will read the HTML content in the doc and generate instrumented code by 
 * injecting "data-cloud9-id" attributes. Additionally, it caches the parsed DOM for use
 * by future updates.
 *
 * As the user makes edits in the session, we determine how the DOM structure should change
 * based on the edits to the source code; those edits are generated by getUnappliedEditList().
 * HTMLDocument (in LiveDevelopment) takes those edits and sends them to the browser (via
 * RemoteFunctions) so that the DOM structure in the live preview can be updated accordingly.
 *
 * There are also helper functions for returning the tagID associated with a specified
 * position in the document--this is used in live highlighting.
 */
define(function (require, exports, module) {
    "use strict";
    
    var extend = require("ace/lib/oop").mixin;
    var Range = require("ace/range").Range;
    var comparePoints = Range.comparePoints;
    var HTMLSimpleDOM = require("./HTMLSimpleDOM");
    var HTMLDOMDiff = require("./HTMLDOMDiff");

    /**
     * @private
     * Checks if two CodeMirror-style {row, column} positions are equal.
     * @param {{row: number, column: number}} pos1
     * @param {{row: number, column: number}} pos2
     * @return {boolean} true if pos1 and pos2 are equal. Fails if either of them is falsy.
     */
    function _posEq(pos1, pos2) {
        return pos1 && pos2 && pos1.row === pos2.row && pos1.column === pos2.column;
    }
    
    /**
     * @private
     * Filters the given marks to find the ones that correspond to instrumented tags,
     * sorts them by their starting position, and looks up and/or stores their ranges 
     * in the given markCache.
     * @param {Array} marks An array of mark objects returned by CodeMirror.
     * @param {Object} markCache An object that maps tag IDs to {mark, range} objects.
     *     If a mark in the marks array is already in the cache, we use the cached range info,
     *     otherwise we look up its range in CodeMirror and store it in the cache.
     * @return {Array.<{mark: Object, range: {row: number, column: number}}>} The filtered and
     *     sorted array of mark info objects (each of which contains the mark and its range,
     *     so the range doesn't need to be looked up again).
     */
    function _getSortedTagMarks(marks, markCache) {
        throw "not implemented";
        // marks = marks.filter(function (mark) {
        //     return !!mark.tagID;
        // }).map(function (mark) {
        //     // All marks should exist since we just got them from CodeMirror.
        //     if (!markCache[mark.tagID]) {
        //         markCache[mark.tagID] = {mark: mark, range: mark.find()};
        //     }
        //     return markCache[mark.tagID];
        // });
        // marks.sort(function (mark1, mark2) {
        //     return (mark1.range.from.row === mark2.range.from.row ?
        //             mark1.range.from.column - mark2.range.from.column :
        //             mark1.range.from.row - mark2.range.from.row);
        // });
        
        // return marks;
    }
    
    /**
     * @private
     * Finds the mark for the DOM node at the given position in the session.
     * @param {session} session The session containing the instrumented document.
     * @param {{row: number, column: number}} pos The position to find the DOM marker for.
     * @param {boolean} preferParent If true, and the pos is at one or the other edge of the
     *     innermost marked range, return the immediately enclosing mark instead.
     * @param {Object=} markCache An optional cache to look up positions of existing
     *     markers. (This avoids calling the find() operation on marks multiple times, 
     *     which is expensive.)
     * @return {Object} The CodeMirror mark object that represents the DOM node at the
     *     given position.
     */
    function _getNodeAtDocumentPos(session, pos, preferParent, markCache) {
        return findNode(session.dom, pos, preferParent);
    }
    
    function findNode(node, pos, preferParent) {
        var children = node && node.children || [];
        for (var i = 0; i < children.length; i++) {
            var ch = node.children[i];
            if (!ch.children) continue;
            var cmp = comparePoints(pos, ch.endPos);
            if (cmp < 0) {
                if (ch && comparePoints(pos, ch.startPos) > 0)
                    return findNode(ch, pos, preferParent);
                break;
            }
            if (preferParent && cmp === 0)
                return node;
        }
        return node;
    }
    
    /**
     * @private
     * Dumps the current list of mark ranges for instrumented tags to the console. Used for debugging.
     * @param {session} session The session to find the mark ranges for.
     * @param {Object=} nodeMap If specified, a map of tag IDs to DOM nodes, used so we can indicate which tag name
     *     the DOM thinks corresponds to the given mark.
     */
    function _dumpMarks(session, nodeMap) {
        var markCache = {},
            marks = _getSortedTagMarks(session._codeMirror.getAllMarks(), markCache);
        marks.forEach(function (markInfo) {
            var mark = markInfo.mark,
                range = markInfo.range;
            console.log("<" + nodeMap[mark.tagID].tag + "> (" + mark.tagID + ") " +
                        range.from.row + ":" + range.from.column + " - " + range.to.row + ":" + range.to.ch);
        });
    }

    /**
     * Get the instrumented tagID at the specified position. Returns -1 if
     * there are no instrumented tags at the location.
     * The _markText() function must be called before calling this function.
     *
     * NOTE: This function is "private" for now (has a leading underscore), since
     * the API is likely to change in the future.
     *
     * @param {session} session The session to scan. 
     * @return {number} tagID at the specified position, or -1 if there is no tag
     */
    function _getTagIDAtDocumentPos(session, pos, markCache) {
        var match = _getNodeAtDocumentPos(session, pos, false, markCache);

        return (match) ? match.tagID : -1;
    }
    
    /**
     * @constructor
     * Subclass of HTMLSimpleDOM.Builder that builds an updated DOM after changes have been made,
     * and maps nodes from the new DOM to the old DOM by tag ID. For non-structural edits, avoids reparsing
     * the whole session. Also updates marks in the session based on the new DOM state.
     *
     * @param {Object} previousDOM The root of the HTMLSimpleDOM tree representing a previous state of the DOM.
     * @param {session} session The session containing the instrumented HTML.
     * @param {Array=} changeList An optional list of CodeMirror change records representing the
     *     edits the user made in the session since previousDOM was built. If provided, and the
     *     edits are not structural, DOMUpdater will do a fast incremental reparse. If not provided,
     *     or if one of the edits changes the DOM structure, DOMUpdater will reparse the whole DOM.
     */
    function DOMUpdater(previousDOM, session, delta) {
        var text, startOffset = 0, startOffsetPos;
        
        this.isIncremental = false;
        
        if (delta) {
            text = delta.text;
            if (typeof text != "string")
                text = delta.lines.join("\n");
            if (previousDOM) 
                updatePositions(previousDOM, delta);
        }
        
        // If the inserted or removed text doesn't have any characters that could change the
        // structure of the DOM (e.g. by adding or removing a tag boundary), then we can do
        // an incremental reparse of just the parent tag containing the edit. This should just
        // be the marked range that contains the beginning of the edit range, since that position
        // isn't changed by the edit.
        if (text && !isDangerousEdit(text)) {
            // If the edit is right at the beginning or end of a tag, we want to be conservative
            // and use the parent as the edit range.
            var startNode = _getNodeAtDocumentPos(session, delta.range.start, true);
            if (startNode) {
                var range = Range.fromPoints(startNode.startPos, startNode.endPos);
                if (range) {
                    text = session.getTextRange(range);
                    this.changedTagID = startNode.tagID;
                    startOffsetPos = startNode.startPos;
                    startOffset = session.doc.positionToIndex(startOffsetPos);
                    this.isIncremental = true;
                }
            }
        }
        
        
        if (!this.changedTagID) {
            // We weren't able to incrementally update, so just rebuild and diff everything.
            text = session.getValue();
        } 
        
        HTMLSimpleDOM.Builder.call(this, text, startOffset, startOffsetPos);
        this.session = session;
        this.cm = session._codeMirror;
        this.previousDOM = previousDOM;
    }
    
    function isDangerousEdit(text) {
        // We don't consider & dangerous since entities only affect text content, not
        // overall DOM structure.
        return (/[<>\/=\"\']/).test(text);
    }
    
    DOMUpdater.prototype = Object.create(HTMLSimpleDOM.Builder.prototype);
    
    /**
     * @private
     * Returns true if the given node has an ancestor whose tagID is the given ID.
     * @param {Object} node A node from an HTMLSimpleDOM structure.
     * @param {number} id The ID of the tag to check for.
     * @return {boolean} true if the node has an ancestor with that ID.
     */
    function _hasAncestorWithID(node, id) {
        var ancestor = node.parent;
        while (ancestor && ancestor.tagID !== id) {
            ancestor = ancestor.parent;
        }
        return !!ancestor;
    }
    
    /**
     * Overrides the `getID` method to return the tag ID from the document. If a viable tag
     * ID cannot be found in the document marks, then a new ID is returned. This will also
     * assign a new ID if the tag changed between the previous and current versions of this
     * node.
     *
     * @param {Object} newTag tag object for the current element
     * @return {int} best ID
     */
    DOMUpdater.prototype.getID = function (newTag, markCache) {
        // Get the mark at the start of the tagname (not before the beginning of the tag, because that's
        // actually inside the parent).
        var currentTagID = _getTagIDAtDocumentPos(this.session, HTMLSimpleDOM._offsetPos(newTag.startPos, 1), markCache);
        
        // If the new tag is in an unmarked range, or the marked range actually corresponds to an
        // ancestor tag, then this must be a newly inserted tag, so give it a new tag ID.
        if (currentTagID === -1 || _hasAncestorWithID(newTag, currentTagID)) {
            currentTagID = this.getNewID();
        } else {
            // If the tag has changed between the previous DOM and the new one, we assign a new ID
            // so that the old tag will be deleted and the new one inserted.
            var oldNode = this.previousDOM.nodeMap[currentTagID];
            if (!oldNode || oldNode.tag !== newTag.tag) {
                currentTagID = this.getNewID();
            }
        }
        return currentTagID;
    };
    
    /**
     * Updates the CodeMirror marks in the session to reflect the new bounds of nodes in
     * the given nodeMap.
     * @param {Object} nodeMap The node map from the new DOM.
     * @param {Object} markCache The cache of existing mark ranges built during the latest parse.
     */
    DOMUpdater.prototype._updateMarkedRanges = function (nodeMap, markCache) {
        // FUTURE: this is somewhat inefficient (getting all the marks involves passing linearly through
        // the document once), but it doesn't seem to be a hotspot right now.
        var updateIDs = Object.keys(nodeMap),
            cm = this.cm,
            marks = cm.getAllMarks();
        
        cm.operation(function () {
            marks.forEach(function (mark) {
                if (mark.hasOwnProperty("tagID") && nodeMap[mark.tagID]) {
                    var node = nodeMap[mark.tagID],
                        markInfo = markCache[mark.tagID];
                    // If the mark's bounds already match, avoid destroying and recreating the mark,
                    // since that incurs some overhead.
                    if (!(markInfo && _posEq(markInfo.range.from, node.startPos) && _posEq(markInfo.range.to, node.endPos))) {
                        mark.clear();
                        mark = cm.markText(node.startPos, node.endPos);
                        mark.tagID = node.tagID;
                    }
                    updateIDs.splice(updateIDs.indexOf(String(node.tagID)), 1);
                }
            });
            
            // Any remaining updateIDs are new.
            updateIDs.forEach(function (id) {
                var node = nodeMap[id], mark;
                if (node.isElement()) {
                    mark = cm.markText(node.startPos, node.endPos);
                    mark.tagID = Number(id);
                }
            });
        });
    };
    
    /**
     * @private
     * Creates a map from tagIDs to nodes in the given HTMLSimpleDOM subtree and
     * stores it on the root.
     * @param {Object} root The root of an HTMLSimpleDOM tree.
     */
    DOMUpdater.prototype._buildNodeMap = function (root) {
        var nodeMap = {};
        
        function walk(node) {
            if (node.tagID) {
                nodeMap[node.tagID] = node;
            }
            if (node.isElement()) {
                node.children.forEach(walk);
            }
        }
        
        walk(root);
        root.nodeMap = nodeMap;
    };
    
    /**
     * @private
     * Removes all nodes deleted between the oldSubtree and the newSubtree from the given nodeMap,
     * and clears marks associated with those nodes.
     * @param {Object} nodeMap The nodeMap to update to remove deleted items.
     * @param {Object} oldSubtreeMap The nodeMap for the original subtree (which should be a subset of the
     *     first nodeMap).
     * @param {Object} newSubtreeMap The nodeMap for the new subtree.
     */
    DOMUpdater.prototype._handleDeletions = function (nodeMap, oldSubtreeMap, newSubtreeMap) {
        var deletedIDs = [];
        Object.keys(oldSubtreeMap).forEach(function (key) {
            if (!newSubtreeMap.hasOwnProperty(key)) {
                deletedIDs.push(key);
                delete nodeMap[key];
            }
        });
        
        // if (deletedIDs.length) {
        //     // FUTURE: would be better to cache the mark for each node. Also, could
        //     // conceivably combine this with _updateMarkedRanges().
        //     var marks = this.cm.getAllMarks();
        //     marks.forEach(function (mark) {
        //         if (mark.hasOwnProperty("tagID") && deletedIDs.indexOf(mark.tagID) !== -1) {
        //             mark.clear();
        //         }
        //     });
        // }
    };
    
    /**
     * Reparses the document (or a portion of it if we can do it incrementally).
     * Note that in an incremental update, the old DOM is actually mutated (the new
     * subtree is swapped in for the old subtree).
     * @return {?{newDOM: Object, oldSubtree: Object, newSubtree: Object}} newDOM is
     *      the full new DOM. For a full update, oldSubtree is the full old DOM 
     *      and newSubtree is the same as newDOM; for an incremental update,
     *      oldSubtree is the portion of the old tree that was reparsed,
     *      newSubtree is the updated version, and newDOM is actually the same
     *      as the original DOM (with newSubtree swapped in for oldSubtree).
     *      If the document can't be parsed due to invalid HTML, returns null.
     */
    DOMUpdater.prototype.update = function () {
        var markCache = {};
        var newSubtree = this.build(!true, markCache);
        var result = {
            // default result if we didn't identify a changed portion
            newDOM: newSubtree,
            oldSubtree: this.previousDOM,
            newSubtree: newSubtree
        };
        
        if (!newSubtree) {
            return null;
        }

        if (this.changedTagID) {
            // Find the old subtree that's going to get swapped out.
            var oldSubtree = this.previousDOM.nodeMap[this.changedTagID],
                parent = oldSubtree.parent;
            
            // If we didn't have a parent, then the whole tree changed anyway, so
            // we'll just return the default result.
            if (parent) {
                var childIndex = parent.children.indexOf(oldSubtree);
                if (childIndex === -1) {
                    // This should never happen...
                    console.error("DOMUpdater.update(): couldn't locate old subtree in tree");
                } else {
                    // Swap the new subtree in place of the old subtree.
                    oldSubtree.parent = null;
                    newSubtree.parent = parent;
                    parent.children[childIndex] = newSubtree;
                    
                    // Overwrite any node mappings in the parent DOM with the
                    // mappings for the new subtree. We keep the nodeMap around
                    // on the new subtree so that the differ can use it later.
                    extend(this.previousDOM.nodeMap, newSubtree.nodeMap);
                    
                    // Update marked ranges for all items in the new subtree.
                    // this._updateMarkedRanges(newSubtree.nodeMap, markCache);
                    
                    // Build a local nodeMap for the old subtree so the differ can
                    // use it.
                    this._buildNodeMap(oldSubtree);
                    
                    // Clean up the info for any deleted nodes that are no longer in
                    // the new tree.
                    this._handleDeletions(this.previousDOM.nodeMap, oldSubtree.nodeMap, newSubtree.nodeMap);
                    
                    // Update the signatures for all parents of the new subtree.
                    var curParent = parent;
                    while (curParent) {
                        curParent.update();
                        curParent = curParent.parent;
                    }
                    
                    result.newDOM = this.previousDOM;
                    result.oldSubtree = oldSubtree;
                }
            }
        } else {
            this.session.dom = result.newDOM;
        }
        
        return result;
    };
    
    /**
     * @private
     * Builds a new DOM for the current state of the session, diffs it against the
     * previous DOM, and generates a DOM edit list that can be used to replay the
     * diffs in the browser.
     * @param {Object} previousDOM The HTMLSimpleDOM corresponding to the previous state of the session.
     *     Note that in the case of an incremental edit, this will be mutated to create the new DOM
     *     (by swapping out the subtree corresponding to the changed portion).
     * @param {session} session The session containing the instrumented HTML.
     * @param {Array=} changeList If specified, a CodeMirror changelist reflecting all the
     *     text changes in the session since previousDOM was built. If specified, we will
     *     attempt to do an incremental update (although we might fall back to a full update
     *     in various cases). If not specified, we will always do a full update.
     * @return {{dom: Object, edits: Array}} The new DOM representing the current state of the
     *     session, and an array of edits that can be applied to update the browser (see
     *     HTMLDOMDiff for more information on the edit format).
     */
    function _updateDOM(previousDOM, session, delta) {
        var updater = new DOMUpdater(previousDOM, session, delta);
        var result = updater.update();
        if (!result) {
            return { errors: updater.errors };
        }
        
        var edits = HTMLDOMDiff.domdiff(result.oldSubtree, result.newSubtree);
        
        // We're done with the nodeMap that was added to the subtree by the updater.
        if (result.newSubtree !== result.newDOM) {
            delete result.newSubtree.nodeMap;
        }
        
        return {
            errors: updater.errors,
            dom: result.newDOM,
            edits: edits,
            _wasIncremental: updater.isIncremental // for unit tests only
        };
    }
    
    function updatePositions(dom, delta) {
        var start = delta.range.start;
        var end = delta.range.end;
        var sign = delta.action[0] == "i" ? 1 : -1;
        var rowChange = sign * (end.row - start.row);
        var columnChange = sign * (end.column - start.column);
        
        function update(pos) {
            if (pos.row == (sign == -1 ? end.row : start.row))
                pos.column += columnChange;
            if (rowChange)
                pos.row += rowChange;
        }
        function walk(node) {
            if (!node.children) 
                return;
            var sp = node.startPos;
            var ep = node.endPos;
            
            if (sign === 1) {
                var cmpStartPos = comparePoints(start, sp);
                if (cmpStartPos < 0) {
                    update(sp);
                    update(ep);
                    if (!rowChange && sp.row > start.row)
                        return;
                } else {
                    var cmpEndPos = comparePoints(start, ep);
                    if (cmpEndPos < 0) {
                        update(ep);
                    } else {
                        return;
                    }
                }
            } else {
                var cmp = comparePoints(end, sp);
                if (cmp <= 0) {
                    update(sp);
                    update(ep);
                    if (!rowChange && sp.row > end.row)
                        return;
                } else {
                    cmp = comparePoints(start, ep);
                    if (cmp <= 0) {
                        update(ep);
                    } else {
                        return;
                    }
                }
            }
            
            return node.children.some(walk);
        }
        walk(dom);
    }
    
    /**
     * Calculates the DOM edits that are needed to update the browser from the state the
     * session was in the last time that scanDocument(), getInstrumentedHTML(), or
     * getUnappliedEditList() was called (whichever is most recent). Caches this state so
     * it can be used as the base state for the next getUnappliedEditList().
     *
     * For simple text edits, this update is done quickly and incrementally. For structural
     * edits (edits that change the DOM structure or add/remove attributes), the update
     * requires a full reparse. 
     *
     * If the document currently contains invalid HTML, no edits will be generated until 
     * getUnappliedEditList() is called when the document is valid, at which point the edits 
     * will reflect all the changes needed to catch the browser up with all the edits 
     * made while the document was invalid.
     *
     * @param {session} session The session containing the instrumented HTML
     * @param {Array} changeList A CodeMirror change list describing the text changes made
     *     in the session since the last update. If specified, we will attempt to do an
     *     incremental update.
     * @return {Array} edits A list of edits to apply in the browser. See HTMLDOMDiff for
     *     more information on the format of these edits.
     */
    function getUnappliedEditList(session, delta) {
        var dom = session.dom;
        var result = _updateDOM(dom, session, delta);
        
        if (dom && result.errors) {
            dom.errors = result.errors;
        }
        if (result.dom) {
            session.dom = result.dom;
        }
        return result;
    }
    
    /**
     * @private
     * Add SimpleDOMBuilder metadata to browser DOM tree JSON representation
     * @param {Object} root
     */
    function _processBrowserSimpleDOM(browserRoot, sessionRootTagID) {
        var nodeMap = {},
            root;
        
        function _processElement(elem) {
            elem.tagID = elem.attributes["data-cloud9-id"];
            
            // remove data-cloud9-id attribute for diff
            delete elem.attributes["data-cloud9-id"];
            
            elem.children.forEach(function (child) {
                // set parent
                child.parent = elem;
                
                if (child.isElement()) {
                    _processElement(child);
                } else if (child.isText()) {
                    child.update();
                    child.tagID = HTMLSimpleDOM.getTextNodeID(child);
                    
                    nodeMap[child.tagID] = child;
                }
            });
            
            elem.update();
            
            nodeMap[elem.tagID] = elem;

            // Choose the root element based on the root tag in the session.
            // The browser may insert html, head and body elements if missing.
            if (elem.tagID === sessionRootTagID) {
                root = elem;
            }
        }
        
        _processElement(browserRoot);

        root = root || browserRoot;
        root.nodeMap = nodeMap;

        return root;
    }
    
    /**
     * @private
     * Diff the browser DOM with the in-session DOM
     * @param {session} session
     * @param {Object} browserSimpleDOM
     */
    function _getBrowserDiff(session, browserSimpleDOM) {
        var sessionRoot = session.dom,
            browserRoot;
        
        browserRoot = _processBrowserSimpleDOM(browserSimpleDOM, sessionRoot.tagID);
        
        return {
            diff: HTMLDOMDiff.domdiff(sessionRoot, browserRoot),
            browser: browserRoot,
            session: sessionRoot
        };
    }
    
    // @todo
    // $(DocumentManager).on("beforeDocumentDelete", _removeDocFromCache);
    
    /**
     * Parses the document, returning an HTMLSimpleDOM structure and caching it as the
     * initial state of the document. Will return a cached copy of the DOM if the
     * document hasn't changed since the last time scanDocument was called.
     *
     * This is called by generateInstrumentedHTML(), but it can be useful to call it
     * ahead of time so the DOM is cached and doesn't need to be rescanned when the
     * instrumented HTML is requested by the browser.
     *
     * @param {Document} doc The doc to scan. 
     * @return {Object} Root DOM node of the document.
     */
    function scanDocument(session) {
        var value = session.getValue();
        var savedValue = session.c9doc.meta.$savedValue || value;
        if (!session.savedDom)
            session.savedDom = HTMLSimpleDOM.build(savedValue);

        var update;
        if (savedValue != value) {
            session.dom = session.savedDom;
            update = _updateDOM(session.savedDom, session);
            session.dom = update.dom;
            update.dom = session.savedDom;
        } else {
            session.dom = session.savedDom;
            update = {dom : session.savedDom};
        }

        return update;
    }
    
    function syncTagIds(session) {
        var value = session.getValue();
        var savedValue = session.c9doc.meta.$savedValue || value;
        if (!session.savedDom)
            session.savedDom = HTMLSimpleDOM.build(savedValue);

        if (!session.savedDom)
            return {errors: ["save"]};
        
        var update = {};
        if (savedValue != value && !session.dom) {
            session.dom = session.savedDom;
            
            getDeltaList(savedValue, value).forEach(function(delta) {
                updatePositions(session.savedDom, delta);
            });
            update = _updateDOM(session.savedDom, session);
            session.dom = update.dom;
        } else if (session.dom) {
            var edits = HTMLDOMDiff.domdiff(session.savedDom, session.dom);
            update.edits = edits;
        } else {
            session.dom = session.savedDom;
        }

        var getNewID = HTMLSimpleDOM.Builder.newIdGenerator();
        
        var idMap = {};
        function walk(node) {
            if (!node.children)
                return;
            var defaultId = getNewID(node);
            if (node.tagID != defaultId) {
                idMap[defaultId] = node.tagID;
            }
            node.children && node.children.forEach(walk);
        }
        
        walk(session.savedDom);
        
        update.dom = null;
        update.idMap = idMap; 
        
        return update;
    }

    function getDeltaList(v1, v2) {
        var DiffMatchPatch = require("plugins/c9.ide.threewaymerge/diff_match_patch_amd").diff_match_patch;
        var dfm = new DiffMatchPatch();

        var row = 0, column = 0;
        var deltas = [];
        
        dfm.diff_main(v1, v2).forEach(function(change) {
            var text = change[1];
            var lines = text.split(/\r\n|\r|\n/);
            var colCh = lines[lines.length - 1].length;
            var rowCh = lines.length - 1;
            var endRow = row + rowCh;
            var endColumn = colCh;
            if (!rowCh) {
                endColumn = column + colCh; 
            }
             
            if (change[0] === 0) {
                row = endRow;
                column = endColumn;
            }
            else if (change[0] == -1) {
                deltas.push({
                    range: new Range(row, column, endRow, endColumn),
                    lines: rowCh && lines,
                    text: !rowCh && text,
                    action: rowCh ? "removeLines" : "removeText"
                });
            }
            else if (change[0] == 1) {
                deltas.push({
                    range: new Range(row, column, endRow, endColumn),
                    lines: rowCh && lines,
                    text: !rowCh && text,
                    action: rowCh ? "insertLines" : "insertText"
                });
                row = endRow;
                column = endColumn;
            }
        });
        
        return deltas;
    }

    
    // private methods
    exports._getNodeAtDocumentPos = _getNodeAtDocumentPos;
    exports._getTagIDAtDocumentPos = _getTagIDAtDocumentPos;
    exports._updateDOM = _updateDOM;
    exports._getBrowserDiff = _getBrowserDiff;

    // public API
    exports.syncTagIds = syncTagIds;
    exports.scanDocument = scanDocument;
    exports.generateInstrumentedHTML = HTMLSimpleDOM.generateInstrumentedHTML;
    exports.getUnappliedEditList = getUnappliedEditList;
    
});
