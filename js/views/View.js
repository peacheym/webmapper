//++++++++++++++++++++++++++++++++++++++//
//              View Class              //
//++++++++++++++++++++++++++++++++++++++//

//changes:
//    on drag, ask tables if snapping
//    have tables/signals indicate attachment direction
//    use only 2 tables
//    use canvas pan and zoom as default
//        can't use for over-table panning in list/link views

// public functions
// resize() // called when window size changes
// update() // called on changes to the model/database
// draw() // called on pan/scroll events
// cleanup() // called when view is destroyed
// type() // returns view type

/* set sigs to have (index), (parent table), (direction), (offset)
 if (!index) {
    view.remove()
    return;
 }
 if (parent_table) {
    use it to find position & direction
 }
 else if (direction) {
    use it to set control pts for edge
 }
 use +/-offset for drawing edges
 */

'use strict';

class View {
    constructor(type, frame, tables, canvas, model) {
        this.type = type;
        this.frame = frame;
        this.tables = tables,
        this.canvas = canvas;
        this.model = model;

        this.srcregexp = null;
        this.dstregexp = null;

        this.draggingFrom = null;
        this.snappingTo = null;
        this.escaped = false;

        this.newMap = null;

        this.dragObj = 'map';
        this.dragging = null;

        // normalized table positions & dimensions
        this.leftTableLeft = 0;
        this.leftTableTop = 0;
        this.leftTableWidth = 0;
        this.leftTableHeight = 1;
        this.leftTableAngle = 0;

        this.rightTableLeft = 1;
        this.rightTableTop = 0;
        this.rightTableWidth = 0;
        this.rightTableHeight = 1;
        this.rightTableAngle = 0;

        if (tables) {
            this.setTableDrag();
        }

        this.mapPane = {'left': frame.left,
                        'top': frame.top,
                        'width': frame.width,
                        'height': frame.height};

        this.svgZoom = 1;
        this.svgPosX = 0;
        this.svgPosY = 0;

        this.canvas.setViewBox(0, 0, frame.width, frame.height, false);
        $('#status').text('');
    }

    resize(newFrame) {
        if (newFrame)
            this.frame = newFrame;

        this.mapPane = {'left': this.frame.left,
                        'top': this.frame.top,
                        'width': this.frame.width,
                        'height': this.frame.height,
                        'cx': this.frame.width * 0.5,
                        'cy': this.frame.height * 0.5};

        this.draw(0);
    }

    tableIndices(key, direction) {
        let rows = [];
        for (var i in this.tables) {
            let s = this.tables[i].getRowFromName(key, direction);
            if (s)
                rows.push({'table': i, 'index': s.index});
        }
        return rows.length ? rows : null;
    }

    updateDevices() {
        for (var i in this.tables)
            this.tables[i].update(model.devices, this.frame.height);

        let self = this;
        let devIndex = 0;
        model.devices.each(function(dev) {
            // update device signals
            let sigIndex = 0;
            dev.signals.each(function(sig) {
                let regexp = sig.direction == 'output' ? self.srcregexp : self.dstregexp;
                if (regexp && !regexp.test(sig.key)) {
                    remove_object_svg(sig);
                    sig.index = null;
                    return;
                }
                sig.index = sigIndex++;

                if (self.tables) {
                    // TODO: check if signalRep exists (e.g. canvas view)
                    sig.tableIndices = self.tableIndices(sig.key, sig.direction);
                    remove_object_svg(sig);
                }
                else {
                    sig.tableIndices = null;
                    if (!sig.view) {
                        sig.view = self.canvas.path(circle_path(0, self.frame.height, 0))
                                              .attr({'fill-opacity': 0,
                                                     'stroke-opacity': 0});
                        self.setSigDrag(sig);
                        self.setSigHover(sig);
                    }
                }
            });
            // if no signals visible, hide device also
            if (!sigIndex) {
                remove_object_svg(dev);
                dev.index = null;
                return;
            }

            dev.index = devIndex++;
            dev.numVisibleSigs = sigIndex + 1;
            if (self.tables) {
                dev.tableIndices = self.tableIndices(dev.key);
                if (!dev.tableIndices) {
                    remove_object_svg(dev);
                    return;
                }
            }
            else
                dev.tableIndices = null;
            if (!dev.view) {
                let path = [['M', self.frame.left + 50, self.frame.height - 50],
                            ['l', 0, 0]];
                dev.view = self.canvas.path().attr({'path': path,
                                                    'fill': dev.color,
                                                    'stroke': dev.color,
                                                    'fill-opacity': 0,
                                                    'stroke-opacity': 0,
                                                    'stroke-linecap': 'round'
                                                   });
                dev.view.click(function(e) {
                    dev.collapsed ^= 3;
                    // TODO: hide signals
                    self.updateDevices();
                    self.draw(200);
                });
            }
        });
    }

    drawDevices(duration) {
        let self = this;
        let cx = this.frame.cx;
        model.devices.each(function(dev) {
            if (!dev.view || !dev.tableIndices || !dev.tableIndices.length)
                return;
            dev.view.stop();
            let path = null;
            if (dev.tableIndices.length == 1) {
                let row = dev.tableIndices[0];
                let pos = self.tables[row.table].getRowFromIndex(row.index);
                path = [['M', pos.left, pos.top],
                        ['l', pos.width, 0],
                        ['l', 0, pos.height],
                        ['l', -pos.width, 0],
                        ['Z']];
            }
            else if (self.tables.right.snap == 'left') {
                let lrow = null, rrow = null;
                let temp = dev.tableIndices[0];
                if (temp.table == 'left')
                    lrow = self.tables.left.getRowFromIndex(temp.index);
                else
                    rrow = self.tables.right.getRowFromIndex(temp.index);
                temp = dev.tableIndices[1];
                if (temp.table == 'right')
                    rrow = self.tables.right.getRowFromIndex(temp.index);
                else
                    lrow = self.tables.left.getRowFromIndex(temp.index);
                if (!lrow || !rrow)
                    return;
                // draw curve linking left and right tables
                path = [['M', lrow.left, lrow.top],
                        ['l', lrow.width, 0],
                        ['C', cx, lrow.top, cx, rrow.top, rrow.left, rrow.top],
                        ['l', rrow.width, 0],
                        ['l', 0, rrow.height],
                        ['l', -rrow.width, 0],
                        ['C', cx, rrow.bottom, cx, lrow.bottom,
                         lrow.right, lrow.bottom],
                        ['l', -lrow.width, 0],
                        ['Z']];
            }
            else {
                let lrow = null, trow = null;
                let temp = dev.tableIndices[0];
                if (temp.table == 'left')
                    lrow = self.tables.left.getRowFromIndex(temp.index);
                else
                    trow = self.tables.right.getRowFromIndex(temp.index);
                temp = dev.tableIndices[1];
                if (temp.table == 'right')
                    trow = self.tables.right.getRowFromIndex(temp.index);
                else
                    lrow = self.tables.left.getRowFromIndex(temp.index);
                if (!lrow || !trow)
                    return;
                // draw "cross" extending from left and top tables
                path = [['M', lrow.left, lrow.top],
                        ['L', trow.left, lrow.top],
                        ['L', trow.left, trow.top],
                        ['L', trow.right, trow.top],
                        ['L', trow.right, lrow.top],
                        ['L', self.frame.right, lrow.top],
                        ['L', self.frame.right, lrow.bottom],
                        ['L', trow.right, lrow.bottom],
                        ['L', trow.right, self.frame.bottom],
                        ['L', trow.left, self.frame.bottom],
                        ['L', trow.left, lrow.bottom],
                        ['L', lrow.left, lrow.bottom],
                        ['Z']];
            }
            if (path) {
                dev.view.toBack();
                dev.view.animate({'path': path,
                                  'fill': dev.color,
                                  'fill-opacity': 0.5,
                                  'stroke-opacity': 0}, duration, '>');
            }
        });
    }

    setSigHover(sig) {
        let self = this;
        sig.view.hover(
            function() {
                let pos = labeloffset(sig.position, sig.key);
                if (!sig.view.label) {
                    sig.view.label = self.canvas.text(pos.x, pos.y, sig.key);
                    sig.view.label.node.setAttribute('pointer-events', 'none');
                }
                else
                    sig.view.label.stop();
                sig.view.label.attr({'x': pos.x,
                                     'y': pos.y,
                                     'fill': 'white',
                                     'opacity': 1,
                                     'font-size': 16,}).toFront();
                if (self.draggingFrom == null)
                    return;
                else if (sig == self.draggingFrom) {
                    // don't snap to self
                    return;
                }
                self.snappingTo = sig;
                let src = self.draggingFrom.position;
                let dst = sig.position;
                let path = [['M', src.x, src.y],
                            ['S', (src.x + dst.x) * 0.6, (src.y + dst.y) * 0.4,
                             dst.x, dst.y]];
                let len = Raphael.getTotalLength(path);
                path = Raphael.getSubpath(path, 10, len - 10);
                self.newMap.attr({'path': path});
            },
            function() {
                self.snappingTo = null;
                if (sig.view.label) {
                    sig.view.label.stop();
                    sig.view.label.animate({'opacity': 0}, 1000, '>', function() {
                        this.remove();
                        sig.view.label = null;
                    });
                }
            }
        );
    }

    setSigDrag(sig) {
        let self = this;
        sig.view.mouseup(function() {
            if (self.draggingFrom && self.snappingTo)
                $('#container').trigger('map', [self.draggingFrom.key,
                                                self.snappingTo.key]);
        });
        sig.view.drag(
            function(dx, dy, x, y, event) {
                if (self.snappingTo)
                    return;
                if (self.escaped) {
                    draggingFrom = null;
                    self.newMap.remove();
                    self.newMap = null;
                    return;
                }
                x -= self.frame.left;
                y -= self.frame.top;
                let src = self.draggingFrom.position;
                let path = [['M', src.x, src.y],
                            ['S', (src.x + x) * 0.6, (src.y + y) * 0.4, x, y]];
                if (!self.newMap) {
                    self.newMap = self.canvas.path(path);
                    self.newMap.attr({'stroke': 'white',
                                      'stroke-width': 2,
                                      'stroke-opacity': 1,
                                      'arrow-start': 'none',
                                      'arrow-end': 'block-wide-long'});
                }
                else
                    self.newMap.attr({'path': path});
            },
            function(x, y, event) {
                self.escaped = false;
                self.draggingFrom = sig;
            },
            function(x, y, event) {
                self.draggingFrom = null;
                if (self.newMap) {
                    self.newMap.remove();
                    self.newMap = null;
                }
            }
        );
    }

    updateSignals(func) {
        let self = this;
        model.devices.each(function(dev) {
            dev.signals.each(function(sig) {
                if (sig.view)
                    sig.view.stop();

                // check regexp
                let regexp = (sig.direction == 'output'
                              ? self.srcregexp : self.dstregexp);
                if (regexp && !regexp.test(sig.key)) {
                    remove_object_svg(sig);
                    sig.index = null;
                    sig.position = null;
                    return;
                }

                if (func && func(sig)) {
                    remove_object_svg(sig);
                    return;
                }

                if (!sig.view && sig.position) {
                    let path = circle_path(sig.position.x, sig.position.y, 7);
                    sig.view = self.canvas.path(path)
                                          .attr({stroke_opacity: 0,
                                                 fill_opacity: 0});
                    self.setSigDrag(sig);
                    self.setSigHover(sig);
                }
            });
        });
    }

    drawSignal(sig, duration) {
        if (!sig.view || !sig.index)
            return;
        sig.view.stop();
        let pos = sig.position;
        let is_output = sig.direction == 'output';

        let path = circle_path(pos.x, pos.y, is_output ? 7 : 10);
        sig.view.animate({'path': path,
                          'fill': is_output ? 'black' : sig.device.color,
                          'fill-opacity': 1,
                          'stroke': sig.device.color,
                          'stroke-width': 6,
                          'stroke-opacity': sig.direction == 'output' ? 1 : 0}, duration, '>');
    }

    drawSignals(duration) {
        let self = this;
        model.devices.each(function(dev) {
            dev.signals.each(function(sig) {
                self.drawSignal(sig, duration);
            });
        });
    }

    updateMaps() {
        let self = this;
        model.maps.each(function(map) {
            // todo: check if signals are visible
            if (!map.view) {
                map.view = self.canvas.path();
                map.view.attr({'stroke-dasharray': map.muted ? '-' : '',
                               'stroke': map.view.selected ? 'red' : 'white',
                               'fill-opacity': 0,
                               'stroke-width': 2});
                map.view.new = true;
            }
        });
    }

    endpoint(sig, dir) {
        if (sig.position)
            return [sig.position.x, sig.position.y, 1, 1];

        if (sig.tableIndices) {
            let loc = sig.tableIndices[0];
            let table = sig.tableIndices[0].table == 'left' ? tables.left : tables.right;
            let row = table.getRowFromIndex(sig.tableIndices[0].index);
            return [row.x, row.y, row.vx, row.vy];
        }

        if (sig.canvasObj) {

        }

        return null;
    }

    drawMaps(duration) {
        let self = this;
        model.maps.each(function(map) {
            if (!map.view)
                return;
            if (map.hidden) {
                map.view.attr({'stroke-opacity': 0}, duration, '>');
                return;
            }
            map.view.stop();
            let src = self.endpoint(map.src);
            let dst = self.endpoint(map.dst);
            if (!src || !dst) {
                console.log('missing infor for map endpoint', map);
                return;
            }
            let x1, y1, x2, y2;
            if (src.table == 'left') {
                // left table
                x1 = self.mapPane.left;
                y1 = (src.index + 0.5) * lh + lo;
            }
            else {
                // right table
                x1 = self.mapPane.right;
                y1 = (src.index + 0.5) * rh + ro;
            }
            if (dst.table == 'left') {
                // left table
                x2 = self.mapPane.left;
                y2 = (dst.index + 0.5) * lh + lo;
            }
            else {
                // right table
                x2 = self.mapPane.right;
                y2 = (dst.index + 0.5) * rh + ro;
            }

            let cy = (y1 + y2) * 0.5;
            let cx = self.mapPane.cx;
            let h_quarter = (cx + x1) * 0.5;
            let y3 = y1 * 0.9 + cy * 0.1;
            let y4 = y2 * 0.9 + cy * 0.1;

            if (x1 == x2) {
                let mult = Math.abs(y1 - y2) * 0.25 + 35;
                cx = x1 < cx ? self.mapPane.left + mult : self.mapPane.right - mult;
            }

            let path = [['M', x1, y1], ['C', cx, y3, cx, y4, x2, y2]];

            if (map.view.new) {
                map.view.new = false;
                if (map.status == "staged") {
                    // draw map directly
                    map.view.attr({'path': path,
                                   'stroke-opacity': 0.5,
                                   'stroke': map.view.selected ? 'red' : 'white',
                                   'arrow-end': 'block-wide-long',
                                   'stroke-dasharray': map.muted ? '-' : ''});
                    return;
                }
                // draw animation following arrow path
                let len = Raphael.getTotalLength(path);
                let path_mid = Raphael.getSubpath(path, 0, len * 0.5);
                map.view.animate({'path': path_mid,
                                  'stroke-opacity': 1.0},
                                 duration * 0.5, '>', function() {
                    this.animate({'path': path}, duration * 0.5, '>', function() {
                        this.attr({'arrow-end': 'block-wide-long'});
                    });
                });
            }
            else {
                map.view.animate({'path': path,
                                  'stroke-opacity': 1.0,
                                  'fill-opacity': 0,
                                  'stroke-width': 2,
                                  'stroke': map.view.selected ? 'red' : 'white'},
                                 duration, '>', function() {
                    this.attr({'arrow-end': 'block-wide-long',
                               'stroke-dasharray': map.muted ? '-' : ''});
                });
            }
        });
    }

    update() {
        console('prototype::update()');
        this.updateDevices();
        this.updateMaps();
    }

    tablePan(x, y, delta_x, delta_y) {
        console.log('tablePan');
        x -= this.frame.left;
        y -= this.frame.top;
        let index, updated = false;
        for (index in this.tables) {
            updated = this.tables[index].pan(delta_x, delta_y, x, y);
            if (updated)
                break;
        }
        if (updated == false) {
            // send to all tables
            for (index in this.tables)
                updated |= this.tables[index].pan(delta_x, delta_y);
        }
        if (updated)
            this.draw(0);
    }

    canvasPan(x, y, delta_x, delta_y) {
        console.log('canvasPan');
        x -= this.frame.left;
        y -= this.frame.top;
        this.svgPosX += delta_x * this.svgZoom;
        this.svgPosY += delta_y * this.svgZoom;

        this.canvas.setViewBox(this.svgPosX, this.svgPosY,
                               this.mapPane.width * this.svgZoom,
                               this.mapPane.height * this.svgZoom, false);
        $('#status').text('pan: ['+this.svgPosX.toFixed(2)+', '+this.svgPosY.toFixed(2)+']')
                    .css({'left': x - this.frame.width * 0.5 + 80,
                          'top': y + 50});
    }

    tableZoom(x, y, delta) {
        console.log('tableZoom');
        x -= this.frame.left;
        y -= this.frame.top;
        let index, updated = false;
        for (index in this.tables) {
            updated = this.tables[index].zoom(delta, x, y, true);
            if (updated != null)
                break;
        }
        if (updated == null) {
            // send to all tables
            for (index in this.tables)
                updated |= this.tables[index].zoom(delta, x, y, false);
        }
        if (updated)
            this.draw(0);
    }

    canvasZoom(x, y, delta) {
        console.log('canvasZoom');
        x -= this.frame.left;
        y -= this.frame.top;
        let newZoom = this.svgZoom + delta * 0.01;
        if (newZoom < 0.1)
            newZoom = 0.1;
        else if (newZoom > 20)
            newZoom = 20;
        if (newZoom == this.svgZoom)
            return;
        let zoomDiff = this.svgZoom - newZoom;
        this.svgPosX += x * zoomDiff;
        this.svgPosY += (y - this.frame.top) * zoomDiff;
        this.canvas.setViewBox(this.svgPosX, this.svgPosY,
                               this.mapPane.width * newZoom,
                               this.mapPane.height * newZoom, false);

        $('#status').text('zoom: '+(100/newZoom).toFixed(2)+'%')
                    .css({'left': x - this.frame.width * 0.5 + 70,
                          'top': y + 50});

        this.svgZoom = newZoom;
    }

    filterSignals(direction, text) {
        console.log('view::filterSignals('+text+')');
        let index, updated = false;
        if (this.tables) {
            for (index in this.tables) {
                updated |= this.tables[index].filterByName(text, direction);
            }
            console.log('updated:', updated);
            if (updated) {
                this.update('signals');
                this.draw(1000);
            }
        }
        else {
            if (direction == 'src')
                this.srcregexp = text ? new RegExp(text, 'i') : null;
            else
                this.dstregexp = text ? new RegExp(text, 'i') : null;
            this.draw(1000);
        }
    }

    escape() {
        this.escaped = true;
        if (this.newMap) {
            this.newMap.remove();
            this.newMap = null;
        }
    }

    setTableDrag() {
        let self = this;
        // dragging maps from table
        // if another table exists, we can drag between them
        // can also drag map to self
        // if tables are orthogonal we can simply drag to 2D space between them
        // if no other table exists, can drag out signal representation
        $('.tableDiv').on('mousedown', 'tr', function(e) {
            self.escaped = false;

            let src_row = this;
            let src_table = null;
            switch ($(src_row).parents('.tableDiv').attr('id')) {
                case "leftTable":
                    src_table = self.tables.left;
                    break;
                case "rightTable":
                    src_table = self.tables.right;
                    break;
                default:
                    console.log('unknown source row');
                    return;
            }
            if ($(src_row).hasClass('device')) {
                let dev = self.model.devices.find(src_row.id);
                if (dev) {
                    switch (src_table) {
                    case self.tables.left:
                        dev.collapsed ^= 1;
                        break;
                    case self.tables.right:
                        dev.collapsed ^= 2;
                        break;
                    case self.tables.top:
                        dev.collapsed ^= 4;
                        break;
                    default:
                        return;
                    }
                    self.updateDevices();
                    self.draw(200);
                }
                return;
            }

            $('svg').one('mouseenter.drawing', function() {
                deselectAllMaps(self.tables);

                var src = src_table.getRowFromName(src_row.id.replace('\\/', '\/'));
                var dst = null;

                self.newMap = self.canvas.path([['M', src.x, src.y],
                                                ['l', 0, 0]])
                                         .attr({'fill-opacity': 0,
                                                'stroke': 'white',
                                                'stroke-opacity': 1,
                                                'stroke-width': 2});

                $('svg, .displayTable tbody tr').on('mousemove.drawing', function(e) {
                    // clear table highlights
                    let index;
                    for (index in self.tables)
                        self.tables[index].highlightRow(null, true);

                    if (self.escaped) {
                        $(document).off('.drawing');
                        $('svg, .displayTable tbody tr').off('.drawing');
                        if (self.newMap) {
                            self.newMap.remove();
                            self.newMap = null;
                        }
                        return;
                    }

                    let x = e.pageX;
                    let y = e.pageY;
                    let path = null;
                    dst = null;
                    let dst_table = null;

                    for (index in self.tables) {
                        // check if cursor is within snapping range
                        dst = self.tables[index].getRowFromPosition(x, y, 0.2);
                        if (dst) {
                            dst_table = self.tables[index];
                            break;
                        }
                    }

                    if (src_table == dst_table) {
                        // draw smooth path from table to self
                        path = [['M', src.x, src.y],
                                ['C',
                                 src.x + src.vx * self.mapPane.width * 0.5,
                                 src.y + src.vy * self.mapPane.height * 0.5,
                                 dst.x + dst.vx * self.mapPane.width * 0.5,
                                 dst.y + dst.vy * self.mapPane.height * 0.5,
                                 dst.x, dst.y]];
                    }
                    else if (dst) {
                        // draw bezier curve connecting src and dst
                        path = [['M', src.x, src.y],
                                ['C',
                                 src.x + src.vx * self.mapPane.width * 0.5,
                                 src.y + src.vy * self.mapPane.height * 0.5,
                                 dst.x + dst.vx * self.mapPane.width * 0.5,
                                 dst.y + dst.vy * self.mapPane.height * 0.5,
                                 dst.x, dst.y]];
                    }
                    else {
                        // draw smooth path connecting src to cursor
                        path = [['M', src.x, src.y],
                                ['S',
                                 src.x + src.vx * self.mapPane.width * 0.5,
                                 src.y + src.vy * self.mapPane.height * 0.5,
                                 x - self.frame.left, y - self.frame.top]];
                    }
                    src_table.highlightRow(src, false);
                    if (dst_table)
                        dst_table.highlightRow(dst, false);

                    self.newMap.attr({'path': path});
                });
                $(document).on('mouseup.drawing', function(e) {
                    $(document).off('.drawing');
                    $('svg, .displayTable tbody tr').off('.drawing');
                    if (dst && dst.id) {
                        $('#container').trigger('map', [src.id, dst.id]);
                    }
                    // clear table highlights
                    self.tables.left.highlightRow(null, true);
                    self.tables.right.highlightRow(null, true);

                    model.maps.add({'src': model.find_signal(src.id),
                                    'dst': model.find_signal(dst.id),
                                    'key': src.id + '->' + dst.id,
                                    'status': 'staged'});
                    self.newMap.remove();
                    self.newMap = null;
                });
            });
            $(document).one('mouseup.drawing', function(e) {
                $(document).off('.drawing');
            });
        });
    }

    cleanup() {
        // clean up any objects created only for this view
        $(document).off('.drawing');
        $('svg, .displayTable tbody tr').off('.drawing');
        $('.tableDiv').off('mousedown');
    }
}
