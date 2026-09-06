package sshsig

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

const namespace = "rtld-admin"

func rsaSigner(t *testing.T) ssh.Signer {
	t.Helper()
	// 2048 rather than 4096: this runs on every test invocation and key
	// generation is the slowest thing in the package.
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func ed25519Signer(t *testing.T) ssh.Signer {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func TestSignVerifyRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		name   string
		signer func(*testing.T) ssh.Signer
	}{
		{"rsa", rsaSigner},
		{"ed25519", ed25519Signer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			signer := tc.signer(t)
			message := []byte(`{"op":"status"}`)

			armored, err := Sign(signer, namespace, message)
			if err != nil {
				t.Fatal(err)
			}
			matched, err := Verify([]ssh.PublicKey{signer.PublicKey()}, namespace, message, armored)
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			if !bytes.Equal(matched.Marshal(), signer.PublicKey().Marshal()) {
				t.Error("verify returned a different key than it was given")
			}
		})
	}
}

// The signature travels in an HTTP header, which cannot carry a newline.
func TestVerifyAcceptsUnwrappedArmour(t *testing.T) {
	signer := rsaSigner(t)
	message := []byte("payload")
	armored, err := Sign(signer, namespace, message)
	if err != nil {
		t.Fatal(err)
	}
	flat := strings.ReplaceAll(string(armored), "\n", "")
	if _, err := Verify([]ssh.PublicKey{signer.PublicKey()}, namespace, message, []byte(flat)); err != nil {
		t.Fatalf("verify unwrapped: %v", err)
	}
}

func TestVerifyRejects(t *testing.T) {
	signer := rsaSigner(t)
	other := ed25519Signer(t)
	message := []byte("payload")
	armored, err := Sign(signer, namespace, message)
	if err != nil {
		t.Fatal(err)
	}
	trusted := []ssh.PublicKey{signer.PublicKey()}

	t.Run("untrusted key", func(t *testing.T) {
		signed, err := Sign(other, namespace, message)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Verify(trusted, namespace, message, signed); !errors.Is(err, ErrNoMatch) {
			t.Fatalf("want ErrNoMatch, got %v", err)
		}
	})

	t.Run("tampered message", func(t *testing.T) {
		if _, err := Verify(trusted, namespace, []byte("payloaD"), armored); err == nil {
			t.Fatal("a modified message verified")
		}
	})

	t.Run("wrong namespace", func(t *testing.T) {
		if _, err := Verify(trusted, "something-else", message, armored); err == nil {
			t.Fatal("a signature from another namespace verified")
		}
	})

	t.Run("truncated armour", func(t *testing.T) {
		if _, err := Verify(trusted, namespace, message, armored[:len(armored)/2]); err == nil {
			t.Fatal("a truncated signature verified")
		}
	})

	t.Run("not a signature", func(t *testing.T) {
		if _, err := Verify(trusted, namespace, message, []byte("hello")); err == nil {
			t.Fatal("arbitrary bytes verified")
		}
	})

	// A default RSA Sign still produces SHA-1. Build that blob by hand and
	// confirm it is turned away rather than quietly accepted.
	t.Run("sha-1 rsa", func(t *testing.T) {
		data, err := signedBytes(namespace, hashAlgorithm, message)
		if err != nil {
			t.Fatal(err)
		}
		legacy, err := signer.Sign(rand.Reader, data)
		if err != nil {
			t.Fatal(err)
		}
		if legacy.Format != ssh.KeyAlgoRSA {
			t.Fatalf("expected a %s signature to build the case, got %s", ssh.KeyAlgoRSA, legacy.Format)
		}
		forged := armor(append([]byte(magic), ssh.Marshal(blob{
			Version:   version,
			PublicKey: string(signer.PublicKey().Marshal()),
			Namespace: namespace,
			HashAlg:   hashAlgorithm,
			Signature: string(ssh.Marshal(legacy)),
		})...))
		if _, err := Verify(trusted, namespace, message, forged); err == nil {
			t.Fatal("a SHA-1 signature verified")
		}
	})
}

func TestParseAuthorizedKeys(t *testing.T) {
	signer := rsaSigner(t)
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))

	t.Run("comments and blanks", func(t *testing.T) {
		keys, err := ParseAuthorizedKeys("# a note\n\n" + line + " me@laptop\n")
		if err != nil {
			t.Fatal(err)
		}
		if len(keys) != 1 {
			t.Fatalf("want 1 key, got %d", len(keys))
		}
	})

	t.Run("escaped newlines", func(t *testing.T) {
		keys, err := ParseAuthorizedKeys(line + `\n` + line)
		if err != nil {
			t.Fatal(err)
		}
		if len(keys) != 2 {
			t.Fatalf("want 2 keys, got %d", len(keys))
		}
	})

	t.Run("empty", func(t *testing.T) {
		if _, err := ParseAuthorizedKeys("  \n# nothing\n"); err == nil {
			t.Fatal("an empty key list was accepted")
		}
	})

	t.Run("junk", func(t *testing.T) {
		if _, err := ParseAuthorizedKeys("not-a-key"); err == nil {
			t.Fatal("junk was accepted as a key")
		}
	})
}

// The format is only useful if it is the same one ssh-keygen writes, so check
// against the real implementation wherever it is installed.
func TestInteropWithSSHKeygen(t *testing.T) {
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen not installed")
	}

	dir := t.TempDir()
	keyPath := filepath.Join(dir, "id_ed25519")
	if out, err := exec.Command(keygen, "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", keyPath).CombinedOutput(); err != nil {
		t.Skipf("could not generate a key: %v: %s", err, out)
	}

	message := []byte(`{"op":"status","ts":1}`)
	messagePath := filepath.Join(dir, "message")
	if err := os.WriteFile(messagePath, message, 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(keygen, "-Y", "sign", "-q", "-f", keyPath, "-n", namespace, messagePath).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen -Y sign: %v: %s", err, out)
	}
	armored, err := os.ReadFile(messagePath + ".sig")
	if err != nil {
		t.Fatal(err)
	}
	authorized, err := os.ReadFile(keyPath + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	keys, err := ParseAuthorizedKeys(string(authorized))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := Verify(keys, namespace, message, armored); err != nil {
		t.Fatalf("verifying an ssh-keygen signature: %v", err)
	}

	// And the other direction: ssh-keygen must accept what Sign writes.
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	private, err := ssh.ParsePrivateKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	ours, err := Sign(private, namespace, message)
	if err != nil {
		t.Fatal(err)
	}
	ourSigPath := filepath.Join(dir, "ours.sig")
	if err := os.WriteFile(ourSigPath, ours, 0o600); err != nil {
		t.Fatal(err)
	}
	allowed := filepath.Join(dir, "allowed_signers")
	if err := os.WriteFile(allowed, []byte("test@example.com "+string(authorized)), 0o600); err != nil {
		t.Fatal(err)
	}
	verify := exec.Command(keygen, "-Y", "verify", "-f", allowed, "-I", "test@example.com",
		"-n", namespace, "-s", ourSigPath)
	verify.Stdin = bytes.NewReader(message) // -Y verify reads the message from stdin.
	out, err := verify.CombinedOutput()
	if err != nil {
		t.Fatalf("ssh-keygen -Y verify rejected our signature: %v: %s", err, out)
	}
}
