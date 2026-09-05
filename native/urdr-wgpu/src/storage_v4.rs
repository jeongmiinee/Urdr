use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
};

use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};

const MAGIC: &[u8; 8] = b"URDR4\0\r\n";
const FORMAT_VERSION: u16 = 1;
const MAX_ENTRY_COUNT: usize = 100_000;
const MAX_NAME_BYTES: usize = 4_096;
const MAX_BLOB_BYTES: usize = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveBlob {
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Urdr4Archive {
    pub root_json: Vec<u8>,
    pub blobs: BTreeMap<String, Vec<u8>>,
}

pub fn write_archive(
    path: &Path,
    root_json: &[u8],
    blobs: impl IntoIterator<Item = ArchiveBlob>,
) -> Result<(), String> {
    let bytes = encode_archive(root_json, blobs)?;
    let temporary = path.with_extension("urdr.tmp");
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    if path.is_file() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub fn is_urdr4(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

pub fn encode_archive(
    root_json: &[u8],
    blobs: impl IntoIterator<Item = ArchiveBlob>,
) -> Result<Vec<u8>, String> {
    if root_json.len() > MAX_BLOB_BYTES {
        return Err("URDR4 root document is too large".to_owned());
    }
    let root = compress(root_json)?;
    let mut entries = blobs.into_iter().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    entries.dedup_by(|left, right| left.name == right.name);
    if entries.len() > MAX_ENTRY_COUNT {
        return Err("URDR4 archive contains too many blobs".to_owned());
    }

    let mut encoded_entries = Vec::with_capacity(entries.len());
    for entry in entries {
        validate_name(&entry.name)?;
        if entry.data.len() > MAX_BLOB_BYTES {
            return Err(format!("URDR4 blob is too large: {}", entry.name));
        }
        let checksum = checksum64(&entry.data);
        let compressed = compress(&entry.data)?;
        encoded_entries.push((entry.name, entry.data.len() as u64, checksum, compressed));
    }

    let header_bytes = encoded_entries.iter().try_fold(0_usize, |total, entry| {
        total
            .checked_add(2 + entry.0.len() + 8 + 8 + 8)
            .ok_or_else(|| "URDR4 header size overflow".to_owned())
    })?;
    let payload_bytes = encoded_entries
        .iter()
        .try_fold(root.len(), |total, entry| {
            total
                .checked_add(entry.3.len())
                .ok_or_else(|| "URDR4 payload size overflow".to_owned())
        })?;
    let mut output = Vec::with_capacity(8 + 2 + 4 + 8 + 8 + 8 + header_bytes + payload_bytes);
    output.extend_from_slice(MAGIC);
    output.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    output.extend_from_slice(&(encoded_entries.len() as u32).to_le_bytes());
    output.extend_from_slice(&(root_json.len() as u64).to_le_bytes());
    output.extend_from_slice(&(root.len() as u64).to_le_bytes());
    output.extend_from_slice(&checksum64(root_json).to_le_bytes());
    for (name, raw_len, checksum, compressed) in &encoded_entries {
        output.extend_from_slice(&(name.len() as u16).to_le_bytes());
        output.extend_from_slice(name.as_bytes());
        output.extend_from_slice(&raw_len.to_le_bytes());
        output.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
        output.extend_from_slice(&checksum.to_le_bytes());
    }
    output.extend_from_slice(&root);
    for (_, _, _, compressed) in encoded_entries {
        output.extend_from_slice(&compressed);
    }
    Ok(output)
}

pub fn decode_archive(bytes: &[u8]) -> Result<Urdr4Archive, String> {
    let mut cursor = Cursor::new(bytes);
    if cursor.take(MAGIC.len())? != MAGIC {
        return Err("Not an URDR4 archive".to_owned());
    }
    let version = cursor.u16()?;
    if version != FORMAT_VERSION {
        return Err(format!("Unsupported URDR4 format version: {version}"));
    }
    let entry_count = cursor.u32()? as usize;
    if entry_count > MAX_ENTRY_COUNT {
        return Err("URDR4 archive contains too many blobs".to_owned());
    }
    let root_raw_len = checked_len(cursor.u64()?)?;
    let root_compressed_len = checked_len(cursor.u64()?)?;
    let root_checksum = cursor.u64()?;
    let mut entries = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        let name_len = cursor.u16()? as usize;
        if name_len == 0 || name_len > MAX_NAME_BYTES {
            return Err("Invalid URDR4 blob name length".to_owned());
        }
        let name = std::str::from_utf8(cursor.take(name_len)?)
            .map_err(|_| "URDR4 blob name is not UTF-8".to_owned())?
            .to_owned();
        validate_name(&name)?;
        let raw_len = checked_len(cursor.u64()?)?;
        let compressed_len = checked_len(cursor.u64()?)?;
        let checksum = cursor.u64()?;
        entries.push((name, raw_len, compressed_len, checksum));
    }
    let root = decompress(cursor.take(root_compressed_len)?, root_raw_len)?;
    if checksum64(&root) != root_checksum {
        return Err("URDR4 root checksum mismatch".to_owned());
    }
    let mut blobs = BTreeMap::new();
    for (name, raw_len, compressed_len, checksum) in entries {
        let data = decompress(cursor.take(compressed_len)?, raw_len)?;
        if checksum64(&data) != checksum {
            return Err(format!("URDR4 blob checksum mismatch: {name}"));
        }
        if blobs.insert(name.clone(), data).is_some() {
            return Err(format!("Duplicate URDR4 blob: {name}"));
        }
    }
    if !cursor.remaining().is_empty() {
        return Err("URDR4 archive has trailing bytes".to_owned());
    }
    Ok(Urdr4Archive {
        root_json: root,
        blobs,
    })
}

fn compress(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
    encoder
        .write_all(bytes)
        .map_err(|error| error.to_string())?;
    encoder.finish().map_err(|error| error.to_string())
}

fn decompress(bytes: &[u8], expected_len: usize) -> Result<Vec<u8>, String> {
    let decoder = ZlibDecoder::new(bytes);
    let mut output = Vec::with_capacity(expected_len.min(16 * 1024 * 1024));
    decoder
        .take(expected_len as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|error| error.to_string())?;
    if output.len() != expected_len {
        return Err("URDR4 decompressed length mismatch".to_owned());
    }
    Ok(output)
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || name.contains('\0')
        || name.contains("..")
        || name.starts_with('/')
        || name.starts_with('\\')
    {
        Err(format!("Invalid URDR4 blob name: {name}"))
    } else {
        Ok(())
    }
}

fn checked_len(value: u64) -> Result<usize, String> {
    if value > MAX_BLOB_BYTES as u64 || value > usize::MAX as u64 {
        Err("URDR4 entry length is outside supported limits".to_owned())
    } else {
        Ok(value as usize)
    }
}

fn checksum64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| "Truncated URDR4 archive".to_owned())?;
        let result = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(result)
    }

    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(
            self.take(2)?.try_into().expect("two bytes"),
        ))
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("four bytes"),
        ))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().expect("eight bytes"),
        ))
    }

    fn remaining(&self) -> &'a [u8] {
        &self.bytes[self.offset..]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_round_trips_independent_binary_blobs() {
        let bytes = encode_archive(
            br#"{"format":"urdr-native-3.7"}"#,
            [
                ArchiveBlob {
                    name: "surfaces/map-a.urs".to_owned(),
                    data: (0..100_000).map(|value| value as u8).collect(),
                },
                ArchiveBlob {
                    name: "history/timeline.bin".to_owned(),
                    data: vec![7, 4, 2, 9],
                },
            ],
        )
        .unwrap();
        assert!(is_urdr4(&bytes));
        let decoded = decode_archive(&bytes).unwrap();
        assert_eq!(decoded.root_json, br#"{"format":"urdr-native-3.7"}"#);
        assert_eq!(decoded.blobs["history/timeline.bin"], [7, 4, 2, 9]);
        assert_eq!(decoded.blobs["surfaces/map-a.urs"].len(), 100_000);
    }

    #[test]
    fn corruption_is_rejected_before_deserialization() {
        let mut bytes = encode_archive(
            b"{}",
            [ArchiveBlob {
                name: "surface".to_owned(),
                data: vec![1; 128],
            }],
        )
        .unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x80;
        assert!(decode_archive(&bytes).is_err());
    }
}
