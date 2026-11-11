package domain

import (
	"bytes"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
)

var ErrElementNotFound = errors.New("studio element not found")

type ElementTarget struct {
	ID            string `json:"id,omitempty"`
	Selector      string `json:"selector,omitempty"`
	SelectorIndex *int   `json:"selectorIndex,omitempty"`
}
type EditOperation struct {
	Type     string  `json:"type"`
	Property string  `json:"property,omitempty"`
	Value    *string `json:"value,omitempty"`
}
type EditCommand struct {
	Target     ElementTarget   `json:"target"`
	Operations []EditOperation `json:"operations"`
}
type EditResult struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	MimeType string `json:"mimeType"`
	Revision int64  `json:"revision"`
}

var editName = regexp.MustCompile(`^(?:--)?[a-zA-Z][a-zA-Z0-9_-]{0,99}$`)
var editSelector = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9_-]*|\*)?((?:[.#][a-zA-Z0-9_-]+)*)(?:\[([a-zA-Z0-9_-]+)(?:=["']?([^\]"']+)["']?)?\])?(?::(nth-of-type|nth-child)\(([1-9][0-9]*)\))?$`)
var editClasses = regexp.MustCompile(`[.#][a-zA-Z0-9_-]+`)

func (c EditCommand) Validate() error {
	if len(c.Target.ID) > 200 || len(c.Target.Selector) > 1000 || c.Target.ID == "" && c.Target.Selector == "" || c.Target.SelectorIndex != nil && (*c.Target.SelectorIndex < 0 || *c.Target.SelectorIndex > 10000) || len(c.Operations) < 1 || len(c.Operations) > 64 {
		return ErrInvalid
	}
	for _, o := range c.Operations {
		if o.Value != nil && (len(*o.Value) > 65536 || !utf8.ValidString(*o.Value) || strings.ContainsRune(*o.Value, 0)) {
			return ErrInvalid
		}
		switch o.Type {
		case "style", "attribute":
			if !editName.MatchString(o.Property) || o.Type == "attribute" && (strings.HasPrefix(strings.ToLower(o.Property), "on") || strings.EqualFold(o.Property, "srcdoc")) {
				return ErrInvalid
			}
		case "text":
			if o.Property != "" || o.Value == nil {
				return ErrInvalid
			}
		case "remove":
			if o.Property != "" || o.Value != nil || len(c.Operations) != 1 {
				return ErrInvalid
			}
		default:
			return ErrInvalid
		}
	}
	return nil
}

func editMatches(n *html.Node, parts []string) bool {
	if n == nil || n.Type != html.ElementNode || len(parts) == 0 {
		return false
	}
	m := editSelector.FindStringSubmatch(parts[len(parts)-1])
	if m == nil {
		return false
	}
	attrs := map[string]string{}
	for _, a := range n.Attr {
		attrs[a.Key] = a.Val
	}
	if m[1] != "" && m[1] != "*" && m[1] != n.Data {
		return false
	}
	for _, p := range editClasses.FindAllString(m[2], -1) {
		if p[0] == '#' {
			if attrs["id"] != p[1:] {
				return false
			}
		} else {
			found := false
			for _, cl := range strings.Fields(attrs["class"]) {
				if cl == p[1:] {
					found = true
				}
			}
			if !found {
				return false
			}
		}
	}
	if m[3] != "" {
		v, ok := attrs[m[3]]
		if !ok || m[4] != "" && v != m[4] {
			return false
		}
	}
	if m[5] != "" {
		index := 1
		for p := n.PrevSibling; p != nil; p = p.PrevSibling {
			if p.Type == html.ElementNode && (m[5] == "nth-child" || p.Data == n.Data) {
				index++
			}
		}
		expected, _ := strconv.Atoi(m[6])
		if index != expected {
			return false
		}
	}
	if len(parts) == 1 {
		return true
	}
	if parts[len(parts)-2] == ">" {
		return editMatches(n.Parent, parts[:len(parts)-2])
	}
	for p := n.Parent; p != nil; p = p.Parent {
		if editMatches(p, parts[:len(parts)-1]) {
			return true
		}
	}
	return false
}
func setEditAttribute(n *html.Node, key string, value *string) {
	for i, a := range n.Attr {
		if a.Key == key {
			if value == nil {
				n.Attr = append(n.Attr[:i], n.Attr[i+1:]...)
			} else {
				n.Attr[i].Val = *value
			}
			return
		}
	}
	if value != nil {
		n.Attr = append(n.Attr, html.Attribute{Key: key, Val: *value})
	}
}

// EditHTML mutates parsed saved bytes. It never executes workspace scripts.
func EditHTML(source string, c EditCommand) (string, error) {
	if c.Validate() != nil || len(source) > 8<<20 || !utf8.ValidString(source) {
		return "", ErrInvalid
	}
	parts := strings.Fields(strings.ReplaceAll(c.Target.Selector, ">", " > "))
	if c.Target.ID == "" {
		if len(parts) < 1 || len(parts) > 30 {
			return "", ErrInvalid
		}
		for i, p := range parts {
			if p == ">" {
				if i == 0 || i == len(parts)-1 || parts[i-1] == ">" {
					return "", ErrInvalid
				}
			} else if !editSelector.MatchString(p) {
				return "", ErrInvalid
			}
		}
	}
	root, err := html.Parse(strings.NewReader(source))
	if err != nil {
		return "", ErrInvalid
	}
	var matches []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		found := false
		if n.Type == html.ElementNode {
			if c.Target.ID != "" {
				for _, a := range n.Attr {
					if a.Key == "id" && a.Val == c.Target.ID {
						found = true
					}
				}
			} else {
				found = editMatches(n, parts)
			}
		}
		if found {
			matches = append(matches, n)
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)
	i := 0
	if c.Target.SelectorIndex != nil {
		i = *c.Target.SelectorIndex
	}
	if i >= len(matches) {
		return "", ErrElementNotFound
	}
	n := matches[i]
	if n.Data == "html" || n.Data == "head" || n.Data == "body" || n.Data == "script" || n.Data == "style" {
		return "", ErrInvalid
	}
	for _, o := range c.Operations {
		switch o.Type {
		case "remove":
			n.Parent.RemoveChild(n)
		case "attribute":
			setEditAttribute(n, strings.ToLower(o.Property), o.Value)
		case "text":
			for n.FirstChild != nil {
				n.RemoveChild(n.FirstChild)
			}
			n.AppendChild(&html.Node{Type: html.TextNode, Data: *o.Value})
		case "style":
			var previous string
			for _, a := range n.Attr {
				if a.Key == "style" {
					previous = a.Val
				}
			}
			// Keep every unrelated declaration byte-for-byte, including values
			// containing semicolons inside quoted functions and parentheses.
			var retained []string
			start, depth := 0, 0
			var quote rune
			escaped := false
			for j, r := range previous + ";" {
				if escaped {
					escaped = false
					continue
				}
				if r == '\\' {
					escaped = true
					continue
				}
				if quote != 0 {
					if r == quote {
						quote = 0
					}
					continue
				}
				if r == '\'' || r == '"' {
					quote = r
					continue
				}
				if r == '(' {
					depth++
				}
				if r == ')' {
					depth--
				}
				if r == ';' && depth == 0 {
					decl := strings.TrimSpace(previous[start:min(j, len(previous))])
					name, _, ok := strings.Cut(decl, ":")
					if ok && !strings.EqualFold(strings.TrimSpace(name), o.Property) {
						retained = append(retained, decl)
					}
					start = j + 1
				}
			}
			if o.Value != nil {
				if strings.ContainsAny(*o.Value, "\r\n{}") {
					return "", ErrInvalid
				}
				retained = append(retained, o.Property+":"+*o.Value)
			}
			value := strings.Join(retained, ";")
			setEditAttribute(n, "style", &value)
		}
	}
	var out bytes.Buffer
	if html.Render(&out, root) != nil || out.Len() > 8<<20 {
		return "", ErrInvalid
	}
	return out.String(), nil
}
