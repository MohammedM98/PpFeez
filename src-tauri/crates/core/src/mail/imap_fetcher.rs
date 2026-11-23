//! Real IMAP client (Gmail over TLS on port 993) using the `imap` crate.

use super::fetcher::{ConnectParams, FetchedMessage, FetcherFactory, MailFetcher};
use crate::error::{AppError, AppResult, ErrorCode};
use native_tls::{TlsConnector, TlsStream};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(60);

pub struct ImapFetcherFactory;

type Session = imap::Session<TlsStream<TcpStream>>;

pub struct ImapFetcher {
    session: Session,
}

fn connect_error(detail: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorCode::ImapConnect,
        format!("تعذّر الاتصال بخادم البريد. تحقق من الإنترنت والعنوان والمنفذ. ({detail})"),
    )
}

/// Map a server error text to a contract error code.
pub fn classify_server_error(text: &str) -> AppError {
    let lower = text.to_ascii_lowercase();
    if lower.contains("not enabled for imap")
        || lower.contains("imap access is disabled")
        || lower.contains("imap is disabled")
    {
        AppError::new(
            ErrorCode::ImapDisabled,
            "خدمة IMAP غير مفعّلة في حساب Gmail. فعّلها من إعدادات Gmail ← إعادة التوجيه وPOP/IMAP",
        )
    } else if lower.contains("authenticationfailed")
        || lower.contains("invalid credentials")
        || lower.contains("application-specific password")
        || lower.contains("web login required")
        || lower.contains("login failed")
    {
        AppError::new(
            ErrorCode::ImapAuth,
            "فشل تسجيل الدخول. تأكد من عنوان البريد ومن كلمة مرور التطبيق (16 حرفاً) وأن التحقق بخطوتين مفعّل",
        )
    } else {
        connect_error(text)
    }
}

fn map_err(e: imap::error::Error) -> AppError {
    match e {
        imap::error::Error::No(t) | imap::error::Error::Bad(t) => classify_server_error(&t),
        other => connect_error(other),
    }
}

impl FetcherFactory for ImapFetcherFactory {
    fn connect(&self, p: &ConnectParams) -> AppResult<Box<dyn MailFetcher>> {
        let addr = (p.host.as_str(), p.port)
            .to_socket_addrs()
            .map_err(connect_error)?
            .next()
            .ok_or_else(|| connect_error("no address"))?;
        let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(20)).map_err(connect_error)?;
        tcp.set_read_timeout(Some(TIMEOUT)).map_err(connect_error)?;
        tcp.set_write_timeout(Some(TIMEOUT)).map_err(connect_error)?;
        let tls = TlsConnector::builder().build().map_err(connect_error)?;
        let stream = tls.connect(&p.host, tcp).map_err(connect_error)?;
        let mut client = imap::Client::new(stream);
        client.read_greeting().map_err(map_err)?;
        let session = client.login(&p.email, &p.password).map_err(|(e, _)| map_err(e))?;
        Ok(Box::new(ImapFetcher { session }))
    }
}

impl MailFetcher for ImapFetcher {
    fn folder_count(&mut self) -> AppResult<usize> {
        let names = self.session.list(Some(""), Some("*")).map_err(map_err)?;
        Ok(names.len())
    }

    fn select(&mut self, folder: &str) -> AppResult<u32> {
        // EXAMINE = read-only SELECT: nothing in the mailbox changes.
        let mb = self.session.examine(folder).map_err(map_err)?;
        Ok(mb.uid_validity.unwrap_or(0))
    }

    fn search_paypal(&mut self, after_uid: Option<u32>) -> AppResult<Vec<u32>> {
        let query = match after_uid {
            Some(u) => format!("UID {}:* FROM \"paypal.com\"", u.saturating_add(1)),
            None => "FROM \"paypal.com\"".to_string(),
        };
        let set = self.session.uid_search(query).map_err(map_err)?;
        let mut uids: Vec<u32> = set.into_iter().filter(|u| after_uid.map(|a| *u > a).unwrap_or(true)).collect();
        uids.sort_unstable();
        Ok(uids)
    }

    fn fetch(&mut self, uids: &[u32]) -> AppResult<Vec<FetchedMessage>> {
        if uids.is_empty() {
            return Ok(vec![]);
        }
        let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        let fetches = self.session.uid_fetch(set, "(UID BODY.PEEK[])").map_err(map_err)?;
        let mut out: Vec<FetchedMessage> =
            fetches.iter().filter_map(|f| Some(FetchedMessage { uid: f.uid?, raw: f.body()?.to_vec() })).collect();
        out.sort_by_key(|m| m.uid);
        Ok(out)
    }

    fn logout(&mut self) {
        let _ = self.session.logout();
    }
}
