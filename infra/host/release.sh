#!/usr/bin/env bash
# Download a published runner only after GitHub verifies its immutable release.
fetch_release() {
  local tag="$1" directory="$2" repository version manifest archive commit expected_size expected_sha
  repository="${LOOM_RELEASE_REPOSITORY:?set LOOM_RELEASE_REPOSITORY to the owner/repository publishing Loom}"
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo 'Invalid release repository' >&2; return 1
  }
  [[ "$tag" =~ ^runner-v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || {
    echo 'Expected a pinned runner-vVERSION release' >&2; return 1
  }
  version="${tag#runner-v}"
  manifest="$directory/runner.json"
  archive="loom-runner-$version.tgz"
  gh release verify "$tag" --repo "$repository" >/dev/null || return 1
  gh release download "$tag" --repo "$repository" --pattern runner.json --dir "$directory" || return 1
  gh release verify-asset "$tag" "$manifest" --repo "$repository" >/dev/null || return 1
  jq -e --arg version "$version" '
    . as $release |
    .schemaVersion == 1 and .kind == "runner" and .version == $version and
    (.commit | type == "string" and test("^[a-f0-9]{40}$")) and
    (.protocol | type == "number" and . > 0 and . == floor) and
    (.desktop | .protocol == $release.protocol and
      (.version | type == "string") and .tag == ("desktop-v" + .version) and
      (.commit | type == "string" and test("^[a-f0-9]{40}$"))) and
    (.assets | type == "array" and length == 2 and
      (map(.name) | sort) == (["loom-runner-\($version).tgz", "loom-operator-\($version).tgz"] | sort) and
      all(.[];
        (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
        (.size | type == "number" and . > 0 and . == floor)))
  ' "$manifest" >/dev/null || { echo 'Invalid runner release manifest' >&2; return 1; }
  commit=$(gh api "repos/$repository/commits/$tag" --jq .sha) || return 1
  [ "$(jq -r .commit "$manifest")" = "$commit" ] || {
    echo 'Runner manifest does not match its source tag' >&2; return 1
  }
  gh release download "$tag" --repo "$repository" --pattern "$archive" --dir "$directory" || return 1
  gh release verify-asset "$tag" "$directory/$archive" --repo "$repository" >/dev/null || return 1
  expected_sha=$(jq -r --arg name "$archive" '.assets[] | select(.name == $name) | .sha256' "$manifest")
  expected_size=$(jq -r --arg name "$archive" '.assets[] | select(.name == $name) | .size' "$manifest")
  [ "$(shasum -a 256 "$directory/$archive" | cut -d ' ' -f 1)" = "$expected_sha" ] &&
    [ "$(wc -c <"$directory/$archive" | tr -d '[:space:]')" = "$expected_size" ] || {
    echo 'Runner archive does not match its release manifest' >&2; return 1
  }
  ARCHIVE="$directory/$archive"
}
