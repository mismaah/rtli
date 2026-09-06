// Package sshsig produces and verifies SSHSIG signatures — the format
// ssh-keygen -Y sign writes, specified in OpenSSH's PROTOCOL.sshsig.
//
// It exists because the admin RPC is authenticated by an SSH key the operator
// already has. The obvious alternative, openssl dgst -sign, cannot read a
// modern ~/.ssh/id_rsa at all: ssh-keygen has written its own private-key
// container since 7.8 and openssl only understands PEM. SSHSIG sidesteps that,
// works for every key type, and lets the server hold nothing but a public key.
package sshsig

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"
)

const (
	// magic prefixes both the signature blob and the bytes actually signed. It
	// is the one part of either that is not SSH wire encoding, so it is sliced
	// off and prepended by hand.
	magic = "SSHSIG"
	// version is the only version OpenSSH has ever written.
	version = 1
	// hashAlgorithm is what the message is reduced to before signing. The spec
	// permits sha256; sha512 is what ssh-keygen defaults to.
	hashAlgorithm = "sha512"

	beginMarker = "-----BEGIN SSH SIGNATURE-----"
	endMarker   = "-----END SSH SIGNATURE-----"
	// wrapWidth matches ssh-keygen's armouring, so a signature produced here is
	// byte-identical to one it would have written.
	wrapWidth = 70
)

// ErrNoMatch is returned when the signature is well formed and internally
// consistent but was made by a key that is not trusted here.
var ErrNoMatch = errors.New("sshsig: signature is not from an authorized key")

// blob is the armoured signature's payload, after the magic.
type blob struct {
	Version   uint32
	PublicKey string
	Namespace string
	Reserved  string
	HashAlg   string
	Signature string
}

// signedData is what the signature is actually over. Note that it carries a
// hash of the message rather than the message: that is what lets a signer
// stream a large file, and it is why the namespace and hash algorithm are
// inside the signed bytes — without them a signature could be replayed into a
// different application's namespace.
type signedData struct {
	Namespace string
	Reserved  string
	HashAlg   string
	Hash      string
}

// ParseAuthorizedKeys reads one or more authorized_keys lines.
//
// Literal "\n" escapes are accepted as line breaks: the key arrives through an
// environment variable set from a shell-sourced config file, where a real
// newline is awkward and an escape is what people reach for.
func ParseAuthorizedKeys(raw string) ([]ssh.PublicKey, error) {
	raw = strings.ReplaceAll(raw, `\n`, "\n")
	var keys []ssh.PublicKey
	for line := range strings.SplitSeq(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
		if err != nil {
			return nil, fmt.Errorf("sshsig: parse authorized key: %w", err)
		}
		keys = append(keys, key)
	}
	if len(keys) == 0 {
		return nil, errors.New("sshsig: no keys found")
	}
	return keys, nil
}

// Sign returns an armoured SSHSIG over message, in the given namespace.
func Sign(signer ssh.Signer, namespace string, message []byte) ([]byte, error) {
	public := signer.PublicKey()
	data, err := signedBytes(namespace, hashAlgorithm, message)
	if err != nil {
		return nil, err
	}

	var signature *ssh.Signature
	// An RSA signer signs with SHA-1 unless asked otherwise, and Verify below
	// rejects SHA-1 outright, so the algorithm has to be named here.
	if algorithmSigner, ok := signer.(ssh.AlgorithmSigner); ok && public.Type() == ssh.KeyAlgoRSA {
		signature, err = algorithmSigner.SignWithAlgorithm(rand.Reader, data, ssh.KeyAlgoRSASHA512)
	} else {
		signature, err = signer.Sign(rand.Reader, data)
	}
	if err != nil {
		return nil, fmt.Errorf("sshsig: sign: %w", err)
	}

	payload := blob{
		Version:   version,
		PublicKey: string(public.Marshal()),
		Namespace: namespace,
		HashAlg:   hashAlgorithm,
		Signature: string(ssh.Marshal(signature)),
	}
	return armor(append([]byte(magic), ssh.Marshal(payload)...)), nil
}

// Verify checks an armoured signature against a set of trusted keys and returns
// the one that matched.
//
// The namespace must match exactly: a signature made for some other purpose
// with the same key is not a credential for this one.
func Verify(keys []ssh.PublicKey, namespace string, message, armored []byte) (ssh.PublicKey, error) {
	raw, err := unarmor(armored)
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(raw, []byte(magic)) {
		return nil, errors.New("sshsig: missing magic preamble")
	}

	var payload blob
	if err := ssh.Unmarshal(raw[len(magic):], &payload); err != nil {
		return nil, fmt.Errorf("sshsig: malformed signature: %w", err)
	}
	if payload.Version != version {
		return nil, fmt.Errorf("sshsig: unsupported version %d", payload.Version)
	}
	if payload.Namespace != namespace {
		return nil, fmt.Errorf("sshsig: signature is for namespace %q, not %q", payload.Namespace, namespace)
	}
	if payload.Reserved != "" {
		return nil, errors.New("sshsig: reserved field is not empty")
	}

	public, err := ssh.ParsePublicKey([]byte(payload.PublicKey))
	if err != nil {
		return nil, fmt.Errorf("sshsig: parse embedded public key: %w", err)
	}
	// Which key signed it is decided before any signature maths, so an
	// untrusted key costs nothing to reject.
	matched := match(keys, public)
	if matched == nil {
		return nil, ErrNoMatch
	}

	var signature ssh.Signature
	if err := ssh.Unmarshal([]byte(payload.Signature), &signature); err != nil {
		return nil, fmt.Errorf("sshsig: malformed signature blob: %w", err)
	}
	// SHA-1 is still what a bare "ssh-rsa" signature means, and it is no longer
	// a sound basis for authentication.
	if signature.Format == ssh.KeyAlgoRSA || signature.Format == ssh.KeyAlgoDSA {
		return nil, fmt.Errorf("sshsig: refusing signature algorithm %q", signature.Format)
	}

	data, err := signedBytes(namespace, payload.HashAlg, message)
	if err != nil {
		return nil, err
	}
	if err := matched.Verify(data, &signature); err != nil {
		return nil, fmt.Errorf("sshsig: %w", err)
	}
	return matched, nil
}

// signedBytes assembles the exact byte string the signature covers.
func signedBytes(namespace, hashAlg string, message []byte) ([]byte, error) {
	var digest []byte
	switch hashAlg {
	case "sha512":
		sum := sha512.Sum512(message)
		digest = sum[:]
	case "sha256":
		sum := sha256.Sum256(message)
		digest = sum[:]
	default:
		return nil, fmt.Errorf("sshsig: unsupported hash %q", hashAlg)
	}
	return append([]byte(magic), ssh.Marshal(signedData{
		Namespace: namespace,
		HashAlg:   hashAlg,
		Hash:      string(digest),
	})...), nil
}

func match(keys []ssh.PublicKey, candidate ssh.PublicKey) ssh.PublicKey {
	wire := candidate.Marshal()
	for _, key := range keys {
		if bytes.Equal(key.Marshal(), wire) {
			return key
		}
	}
	return nil
}

func armor(raw []byte) []byte {
	encoded := base64.StdEncoding.EncodeToString(raw)
	var out strings.Builder
	out.WriteString(beginMarker)
	out.WriteByte('\n')
	for len(encoded) > wrapWidth {
		out.WriteString(encoded[:wrapWidth])
		out.WriteByte('\n')
		encoded = encoded[wrapWidth:]
	}
	out.WriteString(encoded)
	out.WriteByte('\n')
	out.WriteString(endMarker)
	out.WriteByte('\n')
	return []byte(out.String())
}

// unarmor accepts the signature both as ssh-keygen writes it and with every
// line break removed, because it travels here in an HTTP header where a newline
// cannot go.
func unarmor(armored []byte) ([]byte, error) {
	text := string(armored)
	start := strings.Index(text, beginMarker)
	if start < 0 {
		return nil, errors.New("sshsig: missing BEGIN marker")
	}
	text = text[start+len(beginMarker):]
	end := strings.Index(text, endMarker)
	if end < 0 {
		return nil, errors.New("sshsig: missing END marker")
	}
	body := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, text[:end])

	raw, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		return nil, fmt.Errorf("sshsig: decode armour: %w", err)
	}
	return raw, nil
}
