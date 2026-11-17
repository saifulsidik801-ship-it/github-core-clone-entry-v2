// gitproto.go — git object model, packfiles and pkt-lines. Standard library only.
// A direct port of the proven Node implementation: SHA-1 ids, tree/commit/tag
// objects, plain (undeltified) packfiles, and the pkt-line framing smart HTTP
// speaks.

package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

const ZeroOID = "0000000000000000000000000000000000000000"

type GitObjectType string

const (
	ObjCommit GitObjectType = "commit"
	ObjTree   GitObjectType = "tree"
	ObjBlob   GitObjectType = "blob"
	ObjTag    GitObjectType = "tag"
)

type GitObject struct {
	Type GitObjectType
	Data []byte
}

type TreeEntry struct {
	Mode string
	Name string
	OID  string
}

var typeCode = map[GitObjectType]int{"commit": 1, "tree": 2, "blob": 3, "tag": 4}
var codeType = map[int]GitObjectType{1: "commit", 2: "tree", 3: "blob", 4: "tag"}

func isObjectID(s string) bool {
	if len(s) != 40 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// hashObject returns the SHA-1 over "<type> <size>\0" + bytes: the object id.
func hashObject(typ GitObjectType, data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s %d\x00", typ, len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

func parseTree(data []byte) ([]TreeEntry, error) {
	var entries []TreeEntry
	off := 0
	for off < len(data) {
		sp := bytes.IndexByte(data[off:], ' ')
		if sp < 0 {
			return nil, errors.New("bad tree entry")
		}
		sp += off
		nul := bytes.IndexByte(data[sp+1:], 0)
		if nul < 0 {
			return nil, errors.New("bad tree entry")
		}
		nul += sp + 1
		if nul+21 > len(data) {
			return nil, errors.New("bad tree entry")
		}
		entries = append(entries, TreeEntry{
			Mode: string(data[off:sp]),
			Name: string(data[sp+1 : nul]),
			OID:  hex.EncodeToString(data[nul+1 : nul+21]),
		})
		off = nul + 21
	}
	return entries, nil
}

// compareTreeNames is git's tree sort: byte order of the name, a directory
// compared as if it ended in '/'.
func compareTreeNames(a, b TreeEntry) int {
	an := a.Name
	if a.Mode == "40000" {
		an += "/"
	}
	bn := b.Name
	if b.Mode == "40000" {
		bn += "/"
	}
	return strings.Compare(an, bn)
}

func buildTree(entries []TreeEntry) []byte {
	sorted := make([]TreeEntry, len(entries))
	copy(sorted, entries)
	sort.Slice(sorted, func(i, j int) bool { return compareTreeNames(sorted[i], sorted[j]) < 0 })
	var buf bytes.Buffer
	for _, e := range sorted {
		fmt.Fprintf(&buf, "%s %s\x00", e.Mode, e.Name)
		raw, _ := hex.DecodeString(e.OID)
		buf.Write(raw)
	}
	return buf.Bytes()
}

type CommitView struct {
	Tree      string
	Parents   []string
	Author    string
	Committer string
	Message   string
}

func parseCommit(data []byte) CommitView {
	blank := bytes.Index(data, []byte("\n\n"))
	headEnd := len(data)
	if blank >= 0 {
		headEnd = blank
	}
	var c CommitView
	if blank >= 0 {
		c.Message = string(data[blank+2:])
	}
	for _, line := range strings.Split(string(data[:headEnd]), "\n") {
		if line == "" {
			continue
		}
		sp := strings.IndexByte(line, ' ')
		key, val := line, ""
		if sp >= 0 {
			key, val = line[:sp], line[sp+1:]
		}
		switch key {
		case "tree":
			c.Tree = val
		case "parent":
			c.Parents = append(c.Parents, val)
		case "author":
			c.Author = val
		case "committer":
			c.Committer = val
		}
	}
	return c
}

func buildCommit(tree string, parents []string, message, author, committer string, timestamp int64) []byte {
	var sb strings.Builder
	fmt.Fprintf(&sb, "tree %s\n", tree)
	for _, p := range parents {
		fmt.Fprintf(&sb, "parent %s\n", p)
	}
	fmt.Fprintf(&sb, "author %s %d +0000\n", author, timestamp)
	fmt.Fprintf(&sb, "committer %s %d +0000\n", committer, timestamp)
	sb.WriteString("\n")
	sb.WriteString(message)
	return []byte(sb.String())
}

type TagView struct {
	Object  string
	Type    string
	Tag     string
	Tagger  string
	Message string
}

func parseTag(data []byte) TagView {
	blank := bytes.Index(data, []byte("\n\n"))
	headEnd := len(data)
	if blank >= 0 {
		headEnd = blank
	}
	var t TagView
	if blank >= 0 {
		t.Message = string(data[blank+2:])
	}
	for _, line := range strings.Split(string(data[:headEnd]), "\n") {
		if line == "" {
			continue
		}
		sp := strings.IndexByte(line, ' ')
		if sp < 0 {
			continue
		}
		switch line[:sp] {
		case "object":
			t.Object = line[sp+1:]
		case "type":
			t.Type = line[sp+1:]
		case "tag":
			t.Tag = line[sp+1:]
		case "tagger":
			t.Tagger = line[sp+1:]
		}
	}
	return t
}

func buildTag(object string, typ GitObjectType, tag, message, tagger string, timestamp int64) []byte {
	return []byte(fmt.Sprintf("object %s\ntype %s\ntag %s\ntagger %s %d +0000\n\n%s",
		object, typ, tag, tagger, timestamp, message))
}

type ObjectLookup func(oid string) *GitObject

// collectReachable returns every object reachable from roots. It errors on a
// missing object.
func collectReachable(roots []string, lookup ObjectLookup) (map[string]bool, error) {
	seen := map[string]bool{}
	var queue []string
	for _, r := range roots {
		if isObjectID(r) {
			queue = append(queue, r)
		}
	}
	for len(queue) > 0 {
		oid := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen[oid] {
			continue
		}
		obj := lookup(oid)
		if obj == nil {
			return nil, fmt.Errorf("object %s is missing from the store", oid)
		}
		seen[oid] = true
		switch obj.Type {
		case ObjCommit:
			c := parseCommit(obj.Data)
			queue = append(queue, c.Tree)
			queue = append(queue, c.Parents...)
		case ObjTag:
			queue = append(queue, parseTag(obj.Data).Object)
		case ObjTree:
			entries, err := parseTree(obj.Data)
			if err != nil {
				return nil, err
			}
			for _, e := range entries {
				if e.Mode != "160000" {
					queue = append(queue, e.OID)
				}
			}
		}
	}
	return seen, nil
}

// isAncestor reports whether oid is reachable from tip following parents.
func isAncestor(oid, tip string, lookup ObjectLookup) bool {
	if oid == tip {
		return true
	}
	seen := map[string]bool{}
	queue := []string{tip}
	for len(queue) > 0 {
		cur := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		obj := lookup(cur)
		if obj == nil || obj.Type != ObjCommit {
			continue
		}
		for _, p := range parseCommit(obj.Data).Parents {
			if p == oid {
				return true
			}
			queue = append(queue, p)
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// packfiles (plain objects only; the suite's client only ever sends plain packs)
// ---------------------------------------------------------------------------

func writePackObjectHeader(typ GitObjectType, size int) []byte {
	code := typeCode[typ]
	var out []byte
	rem := size
	first := byte((code << 4) | (rem & 0x0f))
	rem >>= 4
	for rem > 0 {
		out = append(out, first|0x80)
		first = byte(rem & 0x7f)
		rem >>= 7
	}
	out = append(out, first)
	return out
}

// writePack builds a version-2 packfile from plain objects; the trailer is
// SHA-1 over everything before it.
func writePack(objects []*GitObject) []byte {
	var body bytes.Buffer
	header := make([]byte, 12)
	copy(header[0:4], "PACK")
	binary.BigEndian.PutUint32(header[4:8], 2)
	binary.BigEndian.PutUint32(header[8:12], uint32(len(objects)))
	body.Write(header)
	for _, o := range objects {
		body.Write(writePackObjectHeader(o.Type, len(o.Data)))
		var compressed bytes.Buffer
		w := zlib.NewWriter(&compressed)
		w.Write(o.Data)
		w.Close()
		body.Write(compressed.Bytes())
	}
	pack := body.Bytes()
	sum := sha1.Sum(pack)
	return append(pack, sum[:]...)
}

type PackRead struct {
	Objects map[string]*GitObject
	Count   int
}

func readVarintSize(buf []byte, start int) (size int, next int, first byte, err error) {
	if start >= len(buf) {
		return 0, 0, 0, errors.New("pack truncated")
	}
	b := buf[start]
	first = b
	size = int(b & 0x0f)
	shift := uint(4)
	off := start + 1
	for b&0x80 != 0 {
		if off >= len(buf) {
			return 0, 0, 0, errors.New("pack truncated")
		}
		b = buf[off]
		off++
		size += int(b&0x7f) << shift
		shift += 7
	}
	return size, off, first, nil
}

func readOfsBase(buf []byte, start int) (baseOffset int, next int, err error) {
	if start >= len(buf) {
		return 0, 0, errors.New("pack truncated")
	}
	b := buf[start]
	off := start + 1
	value := int(b & 0x7f)
	for b&0x80 != 0 {
		if off >= len(buf) {
			return 0, 0, errors.New("pack truncated")
		}
		b = buf[off]
		off++
		value = (value+1)*128 + int(b&0x7f)
	}
	return value, off, nil
}

// applyDelta applies a git delta stream to a base object's bytes.
func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	readSize := func() (int, error) {
		v := 0
		shift := uint(0)
		for {
			if off >= len(delta) {
				return 0, errors.New("delta truncated")
			}
			b := delta[off]
			off++
			v += int(b&0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				break
			}
		}
		return v, nil
	}
	srcSize, err := readSize()
	if err != nil {
		return nil, err
	}
	tgtSize, err := readSize()
	if err != nil {
		return nil, err
	}
	if srcSize != len(base) {
		return nil, errors.New("delta base size mismatch")
	}
	out := make([]byte, tgtSize)
	written := 0
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			cpOff, cpSize := 0, 0
			shift := uint(0)
			for bit := 0; bit < 4; bit++ {
				if op&(1<<uint(bit)) != 0 {
					if off >= len(delta) {
						return nil, errors.New("delta truncated")
					}
					cpOff += int(delta[off]) << shift
					off++
				}
				shift += 8
			}
			shift = 0
			for bit := 4; bit < 7; bit++ {
				if op&(1<<uint(bit)) != 0 {
					if off >= len(delta) {
						return nil, errors.New("delta truncated")
					}
					cpSize += int(delta[off]) << shift
					off++
				}
				shift += 8
			}
			if cpSize == 0 {
				cpSize = 0x10000
			}
			copy(out[written:], base[cpOff:cpOff+cpSize])
			written += cpSize
		} else if op != 0 {
			n := int(op & 0x7f)
			if off+n > len(delta) {
				return nil, errors.New("delta truncated")
			}
			copy(out[written:], delta[off:off+n])
			off += n
			written += n
		} else {
			return nil, errors.New("delta opcode 0")
		}
	}
	if written != tgtSize {
		return nil, errors.New("delta size mismatch")
	}
	return out, nil
}

// byteAtATime feeds a zlib stream one byte per Read so the number of bytes the
// stream consumed is exact (a buffered reader would over-read past the stream).
type byteAtATime struct {
	data []byte
	pos  int
}

func (b *byteAtATime) Read(p []byte) (int, error) {
	if b.pos >= len(b.data) {
		return 0, io.EOF
	}
	p[0] = b.data[b.pos]
	b.pos++
	return 1, nil
}

// inflateEntry inflates one zlib stream starting at offset; it returns the
// bytes and the offset just past the stream.
func inflateEntry(pack []byte, offset int, wantSize int) ([]byte, int, error) {
	r := &byteAtATime{data: pack, pos: offset}
	zr, err := zlib.NewReader(r)
	if err != nil {
		return nil, 0, err
	}
	out, err := io.ReadAll(zr)
	zr.Close()
	if err != nil {
		return nil, 0, err
	}
	if len(out) != wantSize {
		return nil, 0, errors.New("pack entry size mismatch")
	}
	return out, r.pos, nil
}

// readPack reads a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries.
func readPack(pack []byte, resolveBase ObjectLookup) (*PackRead, error) {
	if len(pack) < 32 || string(pack[0:4]) != "PACK" {
		return nil, errors.New("bad pack header")
	}
	version := binary.BigEndian.Uint32(pack[4:8])
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("unsupported pack version %d", version)
	}
	count := int(binary.BigEndian.Uint32(pack[8:12]))
	trailerStart := len(pack) - 20
	trailer := hex.EncodeToString(pack[trailerStart:])
	sum := sha1.Sum(pack[:trailerStart])
	if trailer != hex.EncodeToString(sum[:]) {
		return nil, errors.New("pack checksum mismatch")
	}

	type rawEntry struct {
		offset     int
		typeCode   int
		size       int
		data       []byte
		baseOffset int
		baseOID    string
		resolved   *GitObject
		resolvedOK bool
	}
	raw := make([]*rawEntry, 0, count)
	byOffset := map[int]*rawEntry{}
	off := 12
	for i := 0; i < count; i++ {
		entryOffset := off
		size, next, first, err := readVarintSize(pack, off)
		if err != nil {
			return nil, err
		}
		off = next
		tc := int((first >> 4) & 0x07)
		entry := &rawEntry{offset: entryOffset, typeCode: tc, size: size}
		if tc == 6 {
			baseOff, next2, err := readOfsBase(pack, off)
			if err != nil {
				return nil, err
			}
			off = next2
			entry.baseOffset = entryOffset - baseOff
		} else if tc == 7 {
			if off+20 > len(pack) {
				return nil, errors.New("pack truncated")
			}
			entry.baseOID = hex.EncodeToString(pack[off : off+20])
			off += 20
		} else if _, ok := codeType[tc]; !ok {
			return nil, fmt.Errorf("pack entry %d has unknown type code %d", i, tc)
		}
		data, nextOff, err := inflateEntry(pack, off, size)
		if err != nil {
			return nil, err
		}
		entry.data = data
		off = nextOff
		raw = append(raw, entry)
		byOffset[entryOffset] = entry
	}
	if off != trailerStart {
		return nil, errors.New("pack has trailing bytes")
	}

	objects := map[string]*GitObject{}
	byOID := map[string]*rawEntry{}
	resolving := map[int]bool{}
	var resolve func(e *rawEntry) (*GitObject, error)
	resolve = func(e *rawEntry) (*GitObject, error) {
		if e.resolvedOK {
			return e.resolved, nil
		}
		if resolving[e.offset] {
			return nil, errors.New("delta cycle")
		}
		resolving[e.offset] = true
		var typ GitObjectType
		var data []byte
		if e.typeCode == 6 {
			baseEntry, ok := byOffset[e.baseOffset]
			if !ok {
				return nil, errors.New("ofs-delta base missing")
			}
			base, err := resolve(baseEntry)
			if err != nil {
				return nil, err
			}
			typ = base.Type
			data, err = applyDelta(base.Data, e.data)
			if err != nil {
				return nil, err
			}
		} else if e.typeCode == 7 {
			if baseEntry, ok := byOID[e.baseOID]; ok {
				base, err := resolve(baseEntry)
				if err != nil {
					return nil, err
				}
				typ = base.Type
				data, err = applyDelta(base.Data, e.data)
				if err != nil {
					return nil, err
				}
			} else {
				ext := resolveBase(e.baseOID)
				if ext == nil {
					return nil, errors.New("ref-delta base missing")
				}
				typ = ext.Type
				var err error
				data, err = applyDelta(ext.Data, e.data)
				if err != nil {
					return nil, err
				}
			}
		} else {
			typ = codeType[e.typeCode]
			data = e.data
		}
		oid := hashObject(typ, data)
		obj := &GitObject{Type: typ, Data: data}
		e.resolved = obj
		e.resolvedOK = true
		byOID[oid] = e
		delete(resolving, e.offset)
		return obj, nil
	}
	for _, e := range raw {
		obj, err := resolve(e)
		if err != nil {
			return nil, err
		}
		oid := hashObject(obj.Type, obj.Data)
		if _, ok := objects[oid]; !ok {
			objects[oid] = obj
		}
	}
	return &PackRead{Objects: objects, Count: count}, nil
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

func pktLine(payload []byte) []byte {
	out := make([]byte, 4+len(payload))
	copy(out[4:], payload)
	header := fmt.Sprintf("%04x", len(payload)+4)
	copy(out[0:4], header)
	return out
}

func pktLineString(s string) []byte { return pktLine([]byte(s)) }

var pktFlush = []byte("0000")
var pktDelim = []byte("0001")

func pktLines(items [][]byte) []byte {
	var buf bytes.Buffer
	for _, it := range items {
		buf.Write(it)
	}
	return buf.Bytes()
}

type PktKind int

const (
	PktData PktKind = iota
	PktFlush
	PktDelim
	PktResponseEnd
)

type PktPacket struct {
	Kind    PktKind
	Payload []byte
}

func isHex4(s string) bool {
	if len(s) != 4 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// decodePktLines decodes a whole pkt-line stream; trailing bytes after the
// last packet are returned raw.
func decodePktLines(buf []byte) (packets []PktPacket, rest []byte) {
	off := 0
	for off+4 <= len(buf) {
		head := string(buf[off : off+4])
		if !isHex4(head) {
			break
		}
		length := 0
		fmt.Sscanf(head, "%x", &length)
		if length == 0 {
			packets = append(packets, PktPacket{Kind: PktFlush})
			off += 4
			continue
		}
		if length == 1 {
			packets = append(packets, PktPacket{Kind: PktDelim})
			off += 4
			continue
		}
		if length == 2 {
			packets = append(packets, PktPacket{Kind: PktResponseEnd})
			off += 4
			continue
		}
		if length < 4 || off+length > len(buf) {
			break
		}
		packets = append(packets, PktPacket{Kind: PktData, Payload: buf[off+4 : off+length]})
		off += length
	}
	return packets, buf[off:]
}

// demuxSideband splits sideband band-1 payload into pack chunks, collecting
// band-2 progress text.
func demuxSideband(packets []PktPacket) (pack []byte, progress string, err error) {
	var chunks [][]byte
	for _, p := range packets {
		if p.Kind != PktData || len(p.Payload) < 1 {
			continue
		}
		band := p.Payload[0]
		data := p.Payload[1:]
		switch band {
		case 1:
			chunks = append(chunks, data)
		case 2:
			progress += string(data)
		case 3:
			return nil, "", fmt.Errorf("server sideband error: %s", strings.TrimSpace(string(data)))
		}
	}
	return bytes.Join(chunks, nil), progress, nil
}
