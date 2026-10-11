//! Text and negotiated binary packets share one ordered encrypted stream.
use super::*;

pub(super) async fn pump(
    stream: DataPlaneTcpStream,
    queues: (
        &mut mpsc::Receiver<Frame>,
        &mpsc::Sender<Event>,
        Option<&mpsc::Sender<Vec<u8>>>,
    ),
    route: watch::Receiver<RouteStatus>,
) -> Result<()> {
    let (read, write) = tokio::io::split(stream);
    let (incoming, events, packets) = queues;
    // Each I/O future stays alive across health ticks; canceling a partial frame would corrupt framing.
    tokio::try_join!(
        read_frames(read, events, packets),
        write_frames(write, incoming),
        monitor(route, events)
    )?;
    Ok(())
}

async fn monitor(
    mut route: watch::Receiver<RouteStatus>,
    events: &mpsc::Sender<Event>,
) -> Result<()> {
    let mut previous = RouteStatus::default();
    loop {
        let status = route.borrow_and_update().clone();
        if !status.direct {
            return Err(Error::Unavailable);
        }
        if status != previous {
            events
                .send(Event::Status {
                    route: status.clone(),
                })
                .await
                .map_err(|_| Error::Closed)?;
            previous = status;
        }
        route.changed().await.map_err(|_| Error::Closed)?;
    }
}

async fn read_frames(
    mut read: impl AsyncReadExt + Unpin,
    events: &mpsc::Sender<Event>,
    packets: Option<&mpsc::Sender<Vec<u8>>>,
) -> Result<()> {
    loop {
        match framing::read(&mut read).await? {
            Frame::Text(text) => events
                .send(Event::Data { text })
                .await
                .map_err(|_| Error::Closed)?,
            Frame::Binary(bytes) => packets
                .ok_or(Error::Invalid)?
                .send(bytes)
                .await
                .map_err(|_| Error::Closed)?,
        }
    }
}

async fn write_frames(
    mut write: impl AsyncWriteExt + Unpin,
    incoming: &mut mpsc::Receiver<Frame>,
) -> Result<()> {
    while let Some(frame) = incoming.recv().await {
        framing::write(&mut write, frame).await?;
    }
    Err(Error::Closed)
}
