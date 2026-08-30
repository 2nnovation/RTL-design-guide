# Bundled-Data CDC

Bundled-data CDC는 multi-bit payload를 bit별로 synchronize하지 않고 source에서 안정적으로 유지한 뒤, 안전하게 전달된 control event가 destination capture를 지시하는 protocol 계열이다.

> Bundled data의 안전성은 “data는 천천히 변한다”는 기대가 아니라, payload stability와 control ordering을 명시한 contract에서 나온다.

## 1. Basic Structure

```text
Source domain                              Destination domain

payload register ========================> capture register
      │                                         ▲
      └─ request/control ── synchronizer ───────┘
                           optional ack <───────
```

Data path 자체에 independent 2FF를 넣지 않을 수 있지만, capture control은 안전하게 crossing해야 하고 payload는 capture window 전체에서 안정돼야 한다.

## 2. Functional Contract

최소 contract:

1. Source가 payload를 register한다.
2. Payload가 안정된 뒤 request를 발생시킨다.
3. Source는 destination capture가 끝날 때까지 payload를 바꾸지 않는다.
4. Destination은 synchronized request를 보고 payload를 한 번 capture한다.
5. 다음 transaction이 이전 transaction을 overwrite하지 않는다.

```text
src_clk      ↑       ↑       ↑       ↑
payload      old ==== NEW ========================
request      ________/‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾\________

dst_clk        ↑       ↑       ↑       ↑
req_sync                ___/‾‾‾‾‾‾‾‾‾‾
capture                         ↑
```

Diagram은 개념적이다. 실제 synchronizer latency는 phase와 metastability resolution에 따라 달라질 수 있다.

## 3. Closed-Loop Handshake

가장 명확한 형태는 request/acknowledge handshake다.

```text
Source                             Destination
payload held stable =============================
request ─────────────sync────────> capture once
        <────────────sync──────── acknowledge
source may update payload after ack
```

Generic four-phase source behavior:

```systemverilog
typedef enum logic [1:0] {
    IDLE,
    WAIT_ACK_HIGH,
    WAIT_ACK_LOW
} src_state_t;

src_state_t src_state;

assign src_busy = (src_state != IDLE);

always_ff @(posedge src_clk or negedge src_rst_n) begin
    if (!src_rst_n) begin
        src_req   <= 1'b0;
        src_state <= IDLE;
    end else begin
        unique case (src_state)
            IDLE: begin
                if (src_accept && !ack_sync) begin
                    payload_hold <= src_payload;
                    src_req      <= 1'b1;
                    src_state    <= WAIT_ACK_HIGH;
                end
            end

            WAIT_ACK_HIGH: begin
                if (ack_sync) begin
                    src_req   <= 1'b0;
                    src_state <= WAIT_ACK_LOW;
                end
            end

            WAIT_ACK_LOW: begin
                if (!ack_sync)
                    src_state <= IDLE;
            end

            default: begin
                src_req   <= 1'b0;
                src_state <= IDLE;
            end
        endcase
    end
end
```

이 예는 acknowledge가 다시 low로 돌아오기 전에는 다음 transaction을 받지 않는다. Destination도 request high를 한 번 처리하고 acknowledge를 올린 뒤, synchronized request low를 확인하고 acknowledge를 내려야 한다. 실제 interface에서는 `src_accept`가 `IDLE`에서만 허용된다는 ready contract와 illegal-state recovery policy를 함께 정의한다.

## 4. Open-Loop Bundled Data

Acknowledgement 없이 fixed hold-time assumption으로 capture하는 구조도 가능하지만 verification burden이 커진다.

필요한 조건:

- Source가 payload를 충분히 긴 시간 hold
- Destination clock minimum frequency/stop condition 정의
- Control synchronizer latency uncertainty를 포함한 margin
- Back-to-back transaction minimum spacing
- Capture 완료를 source가 몰라도 overwrite가 발생하지 않음

Clock frequency가 dynamic하거나 destination이 멈출 수 있으면 closed-loop handshake가 더 적합할 수 있다.

## 5. Data-to-Control Ordering

Request가 destination에 도달했을 때 payload가 이미 안정돼 있어야 한다.

```text
unsafe possibility:
control path arrives ────────────────> capture
data path     ───────────────────────> still changing
```

Source RTL에서 payload register를 request보다 먼저 update하는 것만으로 physical ordering이 항상 보장되는 것은 아니다. Data/control route와 synchronizer latency를 포함한 implementation assumption을 검토한다.

Project methodology에 따라 다음을 사용할 수 있다.

- source-side register and protocol margin
- destination capture delay stage
- data path max-delay constraint
- control/data relative timing check
- physical placement/routing constraint

Tool-specific 명령은 해당 flow 공식 문서를 따른다.

## 6. Destination Capture Pattern

Destination은 synchronized request의 level 또는 edge를 사용해 payload를 capture한다.

```systemverilog
always_ff @(posedge dst_clk or negedge dst_rst_n) begin
    if (!dst_rst_n) begin
        req_d     <= 1'b0;
        dst_valid <= 1'b0;
    end else begin
        req_d     <= req_sync;
        dst_valid <= 1'b0;

        if (req_sync && !req_d) begin
            dst_payload <= async_payload_bus;
            dst_valid   <= 1'b1;
        end
    end
end
```

`async_payload_bus`라는 이름은 data가 asynchronous path임을 드러내기 위한 것이다. Capture 시점에 protocol상 stable해야 한다.

이 단순 edge-detect pattern은 request가 reset 후 low에서 high로 한 번 올라오는 protocol을 가정한다. Four-phase handshake라면 acknowledge와 request return-to-zero sequence를 함께 설계한다.

## 7. Throughput and Outstanding Transactions

단일 payload hold register는 이전 transaction acknowledge 전까지 새 payload를 받을 수 없다.

```text
initiation interval >= request sync + capture + ack sync + protocol return
```

높은 throughput이 필요하면 다음을 검토한다.

- ping-pong buffers
- multiple-entry queue
- async FIFO
- credit-based protocol

Handshake latency를 constraint로 숨기지 않고 interface throughput requirement와 비교한다.

## 8. Reset Asymmetry

한쪽 domain만 reset되면 다음 문제가 생길 수 있다.

- request는 high인데 destination edge detector baseline은 reset
- acknowledge가 사라져 source busy가 영구 유지
- reset 후 old payload를 new transaction으로 capture
- reset 중 accepted transaction의 ownership 불명확

정책을 선택한다.

- reset이 모든 outstanding transaction을 폐기
- initialization handshake 후 traffic 허용
- source/destination epoch 일치 확인
- reset 중 request 금지와 source retry

Reset을 data value clear만의 문제로 보지 않는다.

## 9. PPA and Timing Trade-offs

### Area

- source payload hold register
- destination capture register
- request/ack synchronizers
- busy/edge-detect control

### Power

Payload는 transaction 사이에 hold되어 bus/operator switching을 줄일 수 있다. 그러나 handshake control과 wide cross-domain routing이 추가된다.

### Timing/Physical

- Wide payload route와 destination capture timing
- Data/control ordering margin
- Synchronizer placement
- Source hold register fanout
- Multiple destination capture 금지 또는 replication strategy

## 10. CDC Tool and Waiver

Bundled-data 구조는 data bus 자체가 unsynchronized crossing으로 보고될 수 있다. Waiver에는 최소한 다음을 기록한다.

- source payload register
- stability 시작/종료 조건
- synchronized control structure
- destination capture point
- no-overwrite/ack protocol
- physical timing verification
- assertions/tests
- owner와 review date

“Control이 synchronize되어 있음” 한 줄만으로 충분하지 않다.

## 11. Verification Strategy

### Source stability

Request outstanding 동안 payload가 변하지 않는지 확인한다.

```systemverilog
ap_payload_stable_while_pending:
    assert property (@(posedge src_clk) disable iff (!src_rst_n)
        src_busy |=> $stable(payload_hold)
    );
```

`src_busy`가 assertion되는 첫 cycle과 ack 처리 cycle의 semantics에 맞게 property를 조정한다.

### No overwrite

Busy 동안 새 accept가 허용되지 않거나 queue에 저장되는지 확인한다.

### Exactly-once capture

Accepted source transaction마다 destination capture가 정확히 한 번 발생하고 payload/tag가 일치하는지 scoreboard 또는 formal mapping으로 검증한다.

### Boundary cases

- Payload update와 request assertion
- Request/ack back-to-back
- Reset during outstanding transfer
- Destination clock stop/resume
- Source retry와 duplicate prevention
- Maximum data route delay corner

## 12. Common Mistakes

- Data가 “오래 유지될 것 같다”는 말만 있고 cycle contract가 없다.
- Request를 payload와 같은 edge에 바꾸고 ordering margin을 검토하지 않는다.
- Source가 acknowledge 전에 payload를 overwrite한다.
- Destination이 request level을 여러 번 capture한다.
- Independent reset에서 phantom/ lost transaction을 정의하지 않는다.
- Wide bus를 false path로만 처리하고 physical stability를 확인하지 않는다.
- Required throughput에 비해 round-trip handshake가 너무 느리다.

## 13. Design Review Checklist

- [ ] Payload coherency 단위와 transaction boundary가 명확한가?
- [ ] Payload가 request보다 먼저 안정되는가?
- [ ] Destination capture 완료까지 source가 payload를 hold하는가?
- [ ] Open-loop라면 clock range와 minimum hold/spacing margin이 증명되는가?
- [ ] Closed-loop라면 request/ack state machine과 reset이 안전한가?
- [ ] Destination이 transaction을 정확히 한 번 capture하는가?
- [ ] Outstanding transaction 수와 throughput requirement가 맞는가?
- [ ] Data/control relative physical timing을 검증하는 방법이 있는가?
- [ ] CDC waiver에 functional/physical/assertion 근거가 남는가?
- [ ] Reset, clock stop와 retry에서 no-loss/no-duplicate를 검증했는가?

## 관련 문서

- [CDC Overview](overview.md)
- [Multi-Bit CDC](multi_bit_cdc.md)
- [Pulse Crossing](pulse_crossing.md)
- [2FF Synchronizer](synchronizer.md)
