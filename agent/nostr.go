package main

// NIP-01 events with BIP340 signatures, exactly as Nostr does them, so the dashboard's verifier
// (and Keykin in v2) accept what this signs and this accepts what they sign.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
)

type Event struct {
	ID        string     `json:"id"`
	Pubkey    string     `json:"pubkey"`
	CreatedAt int64      `json:"created_at"`
	Kind      int        `json:"kind"`
	Tags      [][]string `json:"tags"`
	Content   string     `json:"content"`
	Sig       string     `json:"sig"`
}

// jsonString escapes like JSON.stringify: quote, backslash and control characters only.
func jsonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r < 0x20:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	b.WriteByte('"')
	return b.String()
}

// canonicalJSON writes strings, ints, []string, [][]string and []any the way JSON.stringify does.
func canonicalJSON(v any) string {
	switch x := v.(type) {
	case string:
		return jsonString(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case []string:
		parts := make([]string, len(x))
		for i, s := range x {
			parts[i] = jsonString(s)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case [][]string:
		parts := make([]string, len(x))
		for i, s := range x {
			parts[i] = canonicalJSON(s)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case []any:
		parts := make([]string, len(x))
		for i, s := range x {
			parts[i] = canonicalJSON(s)
		}
		return "[" + strings.Join(parts, ",") + "]"
	}
	panic(fmt.Sprintf("canonicalJSON: %T", v))
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func EventID(ev *Event) string {
	tags := ev.Tags
	if tags == nil {
		tags = [][]string{}
	}
	return sha256Hex(canonicalJSON([]any{0, ev.Pubkey, ev.CreatedAt, ev.Kind, tags, ev.Content}))
}

func NewSecretKey() (string, error) {
	k, err := btcec.NewPrivateKey()
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(k.Serialize()), nil
}

func PublicKey(skHex string) (string, error) {
	b, err := hex.DecodeString(skHex)
	if err != nil || len(b) != 32 {
		return "", errors.New("bad secret key")
	}
	k, _ := btcec.PrivKeyFromBytes(b)
	return hex.EncodeToString(schnorr.SerializePubKey(k.PubKey())), nil
}

func SignEvent(ev *Event, skHex string) error {
	b, err := hex.DecodeString(skHex)
	if err != nil || len(b) != 32 {
		return errors.New("bad secret key")
	}
	k, _ := btcec.PrivKeyFromBytes(b)
	ev.Pubkey = hex.EncodeToString(schnorr.SerializePubKey(k.PubKey()))
	if ev.Tags == nil {
		ev.Tags = [][]string{}
	}
	ev.ID = EventID(ev)
	id, _ := hex.DecodeString(ev.ID)
	sig, err := schnorr.Sign(k, id)
	if err != nil {
		return err
	}
	ev.Sig = hex.EncodeToString(sig.Serialize())
	return nil
}

func isHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil && strings.ToLower(s) == s
}

func VerifyEvent(ev *Event) bool {
	if ev == nil || !isHex(ev.Pubkey, 64) || !isHex(ev.ID, 64) || !isHex(ev.Sig, 128) {
		return false
	}
	if EventID(ev) != ev.ID {
		return false
	}
	pkb, _ := hex.DecodeString(ev.Pubkey)
	pk, err := schnorr.ParsePubKey(pkb)
	if err != nil {
		return false
	}
	sb, _ := hex.DecodeString(ev.Sig)
	sig, err := schnorr.ParseSignature(sb)
	if err != nil {
		return false
	}
	id, _ := hex.DecodeString(ev.ID)
	return sig.Verify(id, pk)
}

func (ev *Event) Tag(name string) string {
	for _, t := range ev.Tags {
		if len(t) >= 2 && t[0] == name {
			return t[1]
		}
	}
	return ""
}

func (ev *Event) TagValues(name string) []string {
	for _, t := range ev.Tags {
		if len(t) >= 1 && t[0] == name {
			return t[1:]
		}
	}
	return nil
}
