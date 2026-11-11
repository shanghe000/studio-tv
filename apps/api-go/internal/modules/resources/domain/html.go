package domain

import (
	"bytes"
	"golang.org/x/net/html"
	"regexp"
	"strconv"
	"strings"
)

type ElementTarget struct {
	ID            string `json:"id"`
	Selector      string `json:"selector"`
	SelectorIndex *int   `json:"selectorIndex"`
}

var simpleSelector = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9_-]*|\*)?((?:[.#][a-zA-Z0-9_-]+)*)(?:\[([a-zA-Z0-9_-]+)(?:=["']?([^\]"']+)["']?)?\])?(?::(nth-of-type|nth-child)\(([1-9][0-9]*)\))?$`)
var selectorToken = regexp.MustCompile(`[.#][a-zA-Z0-9_-]+`)

func matchElement(n *html.Node, s string) bool {
	if n.Type != html.ElementNode {
		return false
	}
	m := simpleSelector.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	if m[1] != "" && m[1] != "*" && m[1] != n.Data {
		return false
	}
	attrs := map[string]string{}
	for _, a := range n.Attr {
		attrs[a.Key] = a.Val
	}
	for _, part := range selectorToken.FindAllString(m[2], -1) {
		if part[0] == '#' {
			if attrs["id"] != part[1:] {
				return false
			}
		} else {
			found := false
			for _, c := range strings.Fields(attrs["class"]) {
				if c == part[1:] {
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
		if !ok || (m[4] != "" && v != m[4]) {
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
	return true
}
func selectorMatch(n *html.Node, parts []string) bool {
	if len(parts) == 0 {
		return false
	}
	if !matchElement(n, parts[len(parts)-1]) {
		return false
	}
	if len(parts) == 1 {
		return true
	}
	previous := parts[len(parts)-2]
	if previous == ">" {
		return n.Parent != nil && selectorMatch(n.Parent, parts[:len(parts)-2])
	}
	for p := n.Parent; p != nil; p = p.Parent {
		if selectorMatch(p, parts[:len(parts)-1]) {
			return true
		}
	}
	return false
}

// RemoveElement parses and edits saved HTML without executing scripts or fetching anything.
// Supports IDs, tag/class/attribute selectors, descendant/child combinators and numeric nth-child/of-type.
func RemoveElement(source string, t ElementTarget) (string, error) {
	if !Text(source, 8*1024*1024, false) || !Text(t.ID, 200, false) || !Text(t.Selector, 1000, false) || (t.ID == "" && t.Selector == "") || t.SelectorIndex != nil && (*t.SelectorIndex < 0 || *t.SelectorIndex > 10000) {
		return "", ErrInvalid
	}
	parts := strings.Fields(strings.ReplaceAll(t.Selector, ">", " > "))
	if t.ID == "" {
		if len(parts) == 0 || len(parts) > 30 {
			return "", ErrInvalid
		}
		for i, p := range parts {
			if p == ">" {
				if i == 0 || i == len(parts)-1 || parts[i-1] == ">" {
					return "", ErrInvalid
				}
			} else if !simpleSelector.MatchString(p) {
				return "", ErrUnsupported
			}
		}
	}
	root, e := html.Parse(strings.NewReader(source))
	if e != nil {
		return "", ErrInvalid
	}
	matches := []*html.Node{}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		found := false
		if t.ID != "" {
			for _, a := range n.Attr {
				if a.Key == "id" && a.Val == t.ID {
					found = true
				}
			}
		} else {
			found = selectorMatch(n, parts)
		}
		if found {
			matches = append(matches, n)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	index := 0
	if t.SelectorIndex != nil {
		index = *t.SelectorIndex
	}
	if index >= len(matches) {
		return "", ErrNotFound
	}
	n := matches[index]
	if n.Parent == nil || n.Data == "html" || n.Data == "head" || n.Data == "body" {
		return "", ErrInvalid
	}
	n.Parent.RemoveChild(n)
	var b bytes.Buffer
	if html.Render(&b, root) != nil {
		return "", ErrInvalid
	}
	return b.String(), nil
}
