// server.go — the HTTP layer: a tiny request context, response helpers, and the
// route dispatcher. Every response carries a non-empty X-GitHub-Request-Id.
// A single mutex serialises application logic (the store is not goroutine-safe);
// Go's net/http still parallelises connection handling and the kernel work, so
// the per-request cost — not the lock — is what the benchmark measures.

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Ctx struct {
	W      http.ResponseWriter
	R      *http.Request
	Store  *Store
	Params []string
	body   []byte
	bodyOK bool
	json   any
	jsonOK bool
}

var requestCounter uint64

func requestID() string {
	n := atomic.AddUint64(&requestCounter, 1)
	return fmt.Sprintf("forge-%x-%x", time.Now().UnixNano(), n)
}

func writeHeaders(w http.ResponseWriter, status int, contentType string, length int, extra map[string]string) {
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Content-Length", fmt.Sprintf("%d", length))
	h.Set("X-GitHub-Request-Id", requestID())
	for k, v := range extra {
		h.Set(k, v)
	}
	w.WriteHeader(status)
}

func sendJSON(c *Ctx, status int, v any, extra map[string]string) {
	body, err := json.Marshal(v)
	if err != nil {
		body = []byte("{}")
	}
	body = append(body, '\n')
	writeHeaders(c.W, status, "application/json", len(body), extra)
	c.W.Write(body)
}

// sendBuf writes precomputed bytes verbatim (the read-workload fast path).
func sendBuf(c *Ctx, status int, body []byte, extra map[string]string) {
	writeHeaders(c.W, status, "application/json", len(body), extra)
	c.W.Write(body)
}

func sendError(c *Ctx, status int, message string) {
	sendJSON(c, status, map[string]any{"message": message}, nil)
}

func sendRaw(c *Ctx, status int, contentType string, body []byte) {
	writeHeaders(c.W, status, contentType, len(body), nil)
	c.W.Write(body)
}

func sendNoContent(c *Ctx) {
	c.W.Header().Set("X-GitHub-Request-Id", requestID())
	c.W.WriteHeader(204)
}

func readBody(c *Ctx) ([]byte, error) {
	if c.bodyOK {
		return c.body, nil
	}
	b, err := io.ReadAll(c.R.Body)
	if err != nil {
		return nil, err
	}
	c.body = b
	c.bodyOK = true
	return b, nil
}

// readJSON parses the request body as JSON. It returns (value, ok): ok is false
// when the body does not parse (the caller sends 400).
func readJSON(c *Ctx) (any, bool) {
	if c.jsonOK {
		return c.json, true
	}
	body, err := readBody(c)
	if err != nil {
		return nil, false
	}
	if len(body) == 0 {
		c.json = nil
		c.jsonOK = true
		return nil, true
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, false
	}
	c.json = v
	c.jsonOK = true
	return v, true
}

func bodyMap(c *Ctx) (map[string]any, bool) {
	v, ok := readJSON(c)
	if !ok {
		return nil, false
	}
	if m, ok := v.(map[string]any); ok {
		return m, true
	}
	return map[string]any{}, true
}

// hasAuth reports whether the request carries a non-empty Bearer token.
func hasAuth(c *Ctx) bool {
	auth := c.R.Header.Get("Authorization")
	return strings.HasPrefix(auth, "Bearer ") && len(strings.TrimSpace(auth[7:])) > 0
}

func header(c *Ctx, name string) string { return c.R.Header.Get(name) }

// tokenLoginHint extracts a login from a JWT-shaped token, when it names one.
func tokenLoginHint(c *Ctx) string {
	auth := c.R.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return ""
	}
	token := strings.TrimSpace(auth[7:])
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := base64URLDecode(parts[1])
	if err != nil {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	for _, k := range []string{"login", "username", "preferred_username"} {
		if s, ok := payload[k].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func decodeSegment(raw string) string {
	if s, err := url.PathUnescape(raw); err == nil {
		return s
	}
	return raw
}

type Route struct {
	Method  string
	Pattern *regexp.Regexp
	Handler func(c *Ctx)
}

var mu sync.Mutex

// dispatch runs the first matching route; the store lock is held for the whole
// handler so the single-threaded store stays consistent under concurrent load.
func dispatch(routes []Route, fallback func(c *Ctx), store *Store, w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	path := r.URL.EscapedPath()
	if path == "" {
		path = r.URL.Path
	}
	c := &Ctx{W: w, R: r, Store: store}
	for _, route := range routes {
		if route.Method != r.Method {
			continue
		}
		m := route.Pattern.FindStringSubmatch(path)
		if m == nil {
			continue
		}
		c.Params = m[1:]
		route.Handler(c)
		return
	}
	fallback(c)
}

func base64URLDecode(s string) ([]byte, error) {
	// RawURLEncoding without padding; tolerate padded input too.
	if m := len(s) % 4; m != 0 {
		s += strings.Repeat("=", 4-m)
	}
	return base64.URLEncoding.DecodeString(s)
}

func base64Encode(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func base64Decode(s string) ([]byte, error) {
	// Strip whitespace (base64 bodies are often wrapped).
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\t", "")
	return base64.StdEncoding.DecodeString(s)
}
